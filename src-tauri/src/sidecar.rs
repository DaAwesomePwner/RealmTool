use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::TryRngCore;
use serde::Serialize;
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        },
        Threading::{
            OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
        },
    },
};

pub const UI_ORIGIN: &str = "http://tauri.localhost";
const MAX_READY_LINE: usize = 4096;
const START_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

// Do not derive Debug: this value contains the per-launch secret.
#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub port: u16,
    pub token: String,
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "OS random source unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn read_ready(mut reader: impl BufRead) -> Result<u16, String> {
    loop {
        let mut line = Vec::new();
        // `take` bounds allocation even if the child never writes a newline.
        (&mut reader)
            .take((MAX_READY_LINE + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "Could not read backend startup handshake")?;
        if line.len() > MAX_READY_LINE {
            return Err("Backend startup line is too long".into());
        }
        if !line.ends_with(b"\n") {
            return Err("Backend closed stdout before READY".into());
        }
        if let Some(json) = line.strip_prefix(b"REALMTOOL_READY ") {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Ready {
                port: u16,
            }
            let ready: Ready =
                serde_json::from_slice(json).map_err(|_| "Malformed backend READY handshake")?;
            if ready.port == 0 {
                return Err("Backend READY port must be nonzero".into());
            }
            return Ok(ready.port);
        }
    }
}

struct Job(OwnedHandle);

impl Job {
    fn new() -> io::Result<Self> {
        // Unnamed, non-inheritable handle: only the shell owns the kill switch.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        // Supervise only the Node sidecar. Its detached launcher (and the game it
        // starts) must survive RealmTool shutdown, crashes and backend restarts.
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        let ok = unsafe {
            AssignProcessToJobObject(
                self.0.as_raw_handle() as HANDLE,
                child.as_raw_handle() as HANDLE,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub struct Sidecar {
    child: Child,
    job: Option<Job>,
    info: BackendInfo,
}

fn spawn_suspended_in_job(command: &mut Command, job: &Job) -> Result<Child, String> {
    // If the shell dies between spawn and assignment, the child remains suspended:
    // it runs no Node code and holds no proxy port. The accepted residual is an
    // inert orphan until explicit termination or system cleanup; closing its pipes
    // alone cannot terminate a suspended Windows process.
    let mut child = command
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
        .spawn()
        .map_err(|_| "Could not start the bundled Node backend")?;
    if job.assign(&child).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Could not assign backend to Job Object".into());
    }
    Ok(child)
}

fn resume_main_thread(child: &Child) -> io::Result<()> {
    // A newly created suspended process has exactly one thread. ToolHelp gives
    // us its ID without replacing std::process::Command's process/pipe handling.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == child.id() {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            let previous_count = unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) };
            if previous_count == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            if previous_count != 1 {
                return Err(io::Error::other("Unexpected backend thread suspend count"));
            }
            return Ok(());
        }
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        found = unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) };
    }
    Err(io::Error::last_os_error())
}

impl Sidecar {
    /// Paths are injected so tests can run the fixture with the development Node.
    #[cfg(test)]
    pub fn start(
        node: &Path,
        script: &Path,
        resources: &Path,
        origin: &str,
        args: &[&str],
    ) -> Result<Self, String> {
        Self::start_cancellable(
            node,
            script,
            resources,
            origin,
            args,
            &AtomicBool::new(false),
        )
    }

    pub fn start_cancellable(
        node: &Path,
        script: &Path,
        resources: &Path,
        origin: &str,
        args: &[&str],
        cancelled: &AtomicBool,
    ) -> Result<Self, String> {
        let token = generate_token()?;
        let job = Job::new().map_err(|_| "Could not create backend Job Object")?;
        let mut command = Command::new(node);
        command
            .arg(script)
            .arg("serve")
            .args(args)
            .env("REALMTOOL_API_TOKEN", &token)
            .env("REALMTOOL_UI_ORIGINS", origin)
            .env("REALMTOOL_RESOURCES", resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = spawn_suspended_in_job(&mut command, &job)?;
        if resume_main_thread(&child).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not resume backend main thread".into());
        }
        let stdout = child.stdout.take().ok_or("Backend stdout is unavailable")?;
        let mut sidecar = Self {
            child,
            job: Some(job),
            info: BackendInfo { port: 0, token },
        };
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let ready = read_ready(&mut reader);
            let valid = ready.is_ok();
            let _ = tx.send(ready);
            if valid {
                // Drain after READY too: logging must never fill the child's stdout pipe.
                let _ = io::copy(&mut reader, &mut io::sink());
            }
        });
        let deadline = Instant::now() + START_TIMEOUT;
        sidecar.info.port = loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Backend startup cancelled".into());
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("Backend did not become ready within 10 seconds")?;
            match rx.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(ready) => break ready?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Backend startup reader stopped".into())
                }
            }
        };
        if sidecar.has_exited()? {
            return Err("Backend exited during startup".into());
        }
        Ok(sidecar)
    }

    pub fn info(&self) -> BackendInfo {
        self.info.clone()
    }

    pub fn has_exited(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|_| "Could not inspect backend process".into())
    }

    pub fn proxy_running(&self) -> Result<bool, String> {
        let body = self.request("GET", "/api/state", Duration::from_millis(750))?;
        let state: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| "Invalid backend state")?;
        match state.pointer("/proxy/state").and_then(|v| v.as_str()) {
            Some("running" | "starting" | "stopping") => Ok(true),
            Some("stopped" | "failed") => Ok(false),
            _ => Err("Unknown backend proxy state".into()),
        }
    }

    fn request(&self, method: &str, path: &str, timeout: Duration) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, self.info.port));
        let mut socket = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|_| "Backend API connection failed")?;
        socket
            .set_write_timeout(Some(timeout))
            .map_err(|_| "Could not set API timeout")?;
        let body = if method == "POST" { "{}" } else { "" };
        // HTTP/1.0 + Connection: close avoids chunked encoding and connection reuse.
        write!(socket, "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.info.port, self.info.token, body.len()).map_err(|_| "Backend API write failed")?;
        let mut response = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("Backend API timed out")?;
            socket
                .set_read_timeout(Some(remaining))
                .map_err(|_| "Could not set API timeout")?;
            let n = socket
                .read(&mut buf)
                .map_err(|_| "Backend API read failed")?;
            if n == 0 {
                break;
            }
            if response.len() + n > 64 * 1024 {
                return Err("Backend API response is too large".into());
            }
            response.extend_from_slice(&buf[..n]);
        }
        let split = response
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or("Invalid backend HTTP response")?;
        let status = response
            .split(|c| *c == b' ')
            .nth(1)
            .ok_or("Missing backend HTTP status")?;
        if status != b"200" && status != b"202" && status != b"204" {
            return Err("Backend API request was rejected".into());
        }
        Ok(response[split + 4..].to_vec())
    }

    fn request_shutdown(&self, timeout: Duration) -> Result<(), String> {
        self.request("POST", "/api/shutdown", timeout).map(|_| ())
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        let _ = self.request_shutdown(Duration::from_millis(500));
        while Instant::now() < deadline {
            if self.has_exited()? {
                self.job.take();
                self.child.stdin.take();
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.job.take(); // CloseHandle terminates every remaining process in the job.
        self.child.stdin.take();
        self.child
            .wait()
            .map_err(|_| "Could not reap terminated backend")?;
        Ok(())
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.job.take();
        self.child.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        io::Cursor,
        path::PathBuf,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{STILL_ACTIVE, WAIT_OBJECT_0},
        System::JobObjects::IsProcessInJob,
        System::Threading::{
            GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        },
    };

    #[test]
    fn suspended_child_cannot_print_until_resumed_inside_job() {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub-sidecar.mjs");
        let job = Job::new().unwrap();
        let mut command = Command::new("node");
        command
            .arg(&script)
            .arg("serve")
            .arg("print-pid-then-ready")
            .env("REALMTOOL_API_TOKEN", generate_token().unwrap())
            .env("REALMTOOL_UI_ORIGINS", UI_ORIGIN)
            .env("REALMTOOL_RESOURCES", script.parent().unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = spawn_suspended_in_job(&mut command, &job).unwrap();
        let mut in_job = 0;
        assert_ne!(
            unsafe {
                IsProcessInJob(
                    child.as_raw_handle() as HANDLE,
                    job.0.as_raw_handle() as HANDLE,
                    &mut in_job,
                )
            },
            0
        );
        assert_ne!(in_job, 0, "Child must be in the job before it runs");

        let stdout = child.stdout.take().unwrap();
        let (pid_tx, pid_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let _ = pid_tx.send(line);
            let _ = ready_tx.send(read_ready(reader));
        });
        assert!(
            matches!(
                pid_rx.recv_timeout(Duration::from_millis(200)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "Suspended child printed before resume"
        );
        assert!(
            matches!(ready_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "READY arrived before resume"
        );
        resume_main_thread(&child).unwrap();
        assert_eq!(
            pid_rx.recv_timeout(Duration::from_secs(3)).unwrap().trim(),
            format!("PID {}", child.id())
        );
        assert!(
            ready_rx
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap()
                > 0
        );
        reader.join().unwrap();
        drop(job);
        assert_eq!(
            unsafe { WaitForSingleObject(child.as_raw_handle() as HANDLE, 3000) },
            WAIT_OBJECT_0
        );
        child.wait().unwrap();
    }

    // Own the process handle so assertion failures also clean up the detached child.
    struct GrandchildFixture {
        dir: PathBuf,
        process: Option<OwnedHandle>,
    }

    impl GrandchildFixture {
        fn capture(&mut self) -> io::Result<()> {
            let pid = std::fs::read_to_string(self.dir.join("pid"))?
                .parse::<u32>()
                .map_err(io::Error::other)?;
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            self.process = Some(unsafe { OwnedHandle::from_raw_handle(handle) });
            Ok(())
        }
    }

    impl Drop for GrandchildFixture {
        fn drop(&mut self) {
            if self.process.is_none() {
                let _ = self.capture();
            }
            if let Some(process) = &self.process {
                unsafe {
                    TerminateProcess(process.as_raw_handle() as HANDLE, 0);
                    WaitForSingleObject(process.as_raw_handle() as HANDLE, 3000);
                }
            }
            let _ = std::fs::remove_file(self.dir.join("pid"));
            let _ = std::fs::remove_dir(&self.dir);
        }
    }

    #[test]
    fn dropping_job_kills_sidecar_but_preserves_detached_grandchild() {
        let dir = std::env::temp_dir().join(format!(
            "realmtool-grandchild-{}",
            generate_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let mut fixture = GrandchildFixture { dir, process: None };
        let pid_path = fixture.dir.join("pid");
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub-sidecar.mjs");
        let mut child = Sidecar::start(
            Path::new("node"),
            &script,
            script.parent().unwrap(),
            UI_ORIGIN,
            &["spawn-grandchild", pid_path.to_str().unwrap()],
        )
        .unwrap();
        fixture.capture().unwrap();
        let process = fixture.process.as_ref().unwrap().as_raw_handle() as HANDLE;
        let mut exit_code = 0;
        assert_ne!(unsafe { GetExitCodeProcess(process, &mut exit_code) }, 0);
        assert_eq!(exit_code, STILL_ACTIVE as u32);

        drop(child.job.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "Job Object did not kill sidecar");
            thread::sleep(Duration::from_millis(10));
        }
        // Job termination is asynchronous: give an incorrectly associated grandchild
        // time to terminate before checking its exit status.
        unsafe {
            WaitForSingleObject(process, 200);
        }
        assert_ne!(unsafe { GetExitCodeProcess(process, &mut exit_code) }, 0);
        assert_eq!(
            exit_code, STILL_ACTIVE as u32,
            "Job closure killed the detached grandchild"
        );
        assert_ne!(unsafe { TerminateProcess(process, 0) }, 0);
        assert_eq!(unsafe { WaitForSingleObject(process, 3000) }, WAIT_OBJECT_0);
    }

    #[test]
    fn tokens_are_random_url_safe_and_unpadded() {
        let mut tokens = HashSet::new();
        for _ in 0..1000 {
            let token = generate_token().unwrap();
            assert_eq!(token.len(), 43);
            assert!(token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
            assert!(tokens.insert(token));
        }
    }

    #[test]
    fn ready_accepts_valid_port_after_junk() {
        assert_eq!(
            read_ready(Cursor::new(b"REALMTOOL_READY {\"port\":12345}\n")).unwrap(),
            12345
        );
        assert_eq!(
            read_ready(Cursor::new(
                b"junk\nother output\r\nREALMTOOL_READY {\"port\":65535}\r\n"
            ))
            .unwrap(),
            65535
        );
    }

    #[test]
    fn ready_rejects_malformed_json_and_invalid_ports() {
        for line in [
            "REALMTOOL_READY nope\n",
            "REALMTOOL_READY {\"port\":0}\n",
            "REALMTOOL_READY {\"port\":65536}\n",
            "REALMTOOL_READY {\"port\":-1}\n",
            "REALMTOOL_READY {\"port\":\"80\"}\n",
        ] {
            assert!(read_ready(Cursor::new(line)).is_err());
        }
    }

    #[test]
    fn ready_rejects_oversize_lines_and_eof() {
        assert!(read_ready(Cursor::new(vec![b'x'; MAX_READY_LINE + 1])).is_err());
        assert!(read_ready(Cursor::new(b"junk\n")).is_err());
        assert!(read_ready(Cursor::new(b"REALMTOOL_READY {\"port\":80}")).is_err());
    }

    fn stub(mode: &str) -> Sidecar {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub-sidecar.mjs");
        Sidecar::start(
            std::path::Path::new("node"),
            &script,
            script.parent().unwrap(),
            UI_ORIGIN,
            &[mode],
        )
        .unwrap()
    }

    #[test]
    fn spawn_and_authenticated_shutdown_exit_within_three_seconds() {
        let mut child = stub("graceful");
        assert!(child.info().port > 0);
        assert_eq!(child.proxy_running().unwrap(), true);
        let start = Instant::now();
        child.shutdown().unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(child.child.try_wait().unwrap().unwrap().success());
    }

    #[test]
    fn dropping_job_kills_child_that_ignores_shutdown() {
        let mut child = stub("ignore");
        child.request_shutdown(Duration::from_millis(300)).unwrap();
        assert!(child.child.try_wait().unwrap().is_none());
        drop(child.job.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "Job Object did not kill child");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn quit_cancels_a_pending_ready_handshake() {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub-sidecar.mjs");
        let cancel = std::sync::atomic::AtomicBool::new(false);
        thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(150));
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            let start = Instant::now();
            assert!(Sidecar::start_cancellable(
                Path::new("node"),
                &script,
                script.parent().unwrap(),
                UI_ORIGIN,
                &["no-ready"],
                &cancel
            )
            .is_err());
            assert!(start.elapsed() < Duration::from_secs(1));
        });
    }

    #[test]
    fn restart_uses_a_fresh_token_and_stdin_eof_stops_the_child() {
        let mut first = stub("graceful");
        let token = first.info().token;
        first.shutdown().unwrap();
        let mut second = stub("graceful");
        assert_ne!(token, second.info().token);
        second.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while second.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "Child ignored stdin EOF");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
