// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::{BackendInfo, Sidecar, UI_ORIGIN};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewWindow, WebviewWindowBuilder,
};

#[derive(Default)]
struct Backend {
    child: Option<Sidecar>,
    starting: bool,
    error: Option<String>,
}

#[derive(Default)]
struct Shell {
    backend: Mutex<Backend>,
    ready: Condvar,
    quitting: AtomicBool,
    closing: AtomicBool,
    hide_notice_shown: AtomicBool,
}

// Task 9 can adjust the installer layout here, without changing supervision.
fn production_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "Could not locate application resources")?;
    Ok((
        root.join("runtime/node.exe"),
        root.join("app/backend/main.mjs"),
        root.join("app"),
    ))
}

fn trusted_origin(url: &tauri::Url) -> bool {
    let origin = url.origin().ascii_serialization();
    origin == UI_ORIGIN || (cfg!(debug_assertions) && origin == "http://localhost:5173")
}

fn validate_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || !trusted_origin(&window.url().map_err(|_| "Cannot verify UI origin")?)
    {
        return Err("Backend access is restricted to the RealmTool window".into());
    }
    Ok(())
}

#[tauri::command]
async fn backend_info(
    window: WebviewWindow,
    shell: tauri::State<'_, Arc<Shell>>,
) -> Result<BackendInfo, String> {
    validate_window(&window)?;
    let shell = shell.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut backend = shell.backend.lock().unwrap_or_else(|e| e.into_inner());
        while backend.starting {
            backend = shell.ready.wait(backend).unwrap_or_else(|e| e.into_inner());
        }
        if shell.quitting.load(Ordering::SeqCst) {
            return Err("RealmTool is shutting down".into());
        }
        backend.child.as_ref().map(Sidecar::info).ok_or_else(|| {
            backend
                .error
                .clone()
                .unwrap_or_else(|| "Backend is unavailable".into())
        })
    })
    .await
    .map_err(|_| "Backend information task failed")?
}

fn begin_start(shell: &Shell) -> Result<(), String> {
    let mut backend = shell.backend.lock().unwrap_or_else(|e| e.into_inner());
    if shell.quitting.load(Ordering::SeqCst) {
        return Err("RealmTool is shutting down".into());
    }
    if backend.starting {
        return Err("Backend is already starting".into());
    }
    if backend
        .child
        .as_mut()
        .is_some_and(|child| !child.has_exited().unwrap_or(false))
    {
        return Err("Backend is already running".into());
    }
    backend.child.take();
    backend.starting = true;
    backend.error = None;
    Ok(())
}

fn finish_start(app: &tauri::AppHandle, shell: &Shell) -> Result<BackendInfo, String> {
    let result = (|| {
        let (node, script, resources) = production_paths(app)?;
        // The navigation callback and JS initialization also verify the actual origin.
        let origin = if cfg!(debug_assertions) && !cfg!(feature = "custom-protocol") {
            "http://localhost:5173"
        } else {
            UI_ORIGIN
        };
        Sidecar::start_cancellable(&node, &script, &resources, origin, &[], &shell.quitting)
    })();
    let mut backend = shell.backend.lock().unwrap_or_else(|e| e.into_inner());
    backend.starting = false;
    let info = match result {
        Ok(mut child) if shell.quitting.load(Ordering::SeqCst) => {
            let _ = child.shutdown();
            Err("RealmTool is shutting down".into())
        }
        Ok(child) => {
            let info = child.info();
            backend.child = Some(child);
            Ok(info)
        }
        Err(error) => {
            backend.error = Some(error.clone());
            Err(error)
        }
    };
    shell.ready.notify_all();
    info
}

#[tauri::command]
async fn restart_backend(
    window: WebviewWindow,
    shell: tauri::State<'_, Arc<Shell>>,
) -> Result<BackendInfo, String> {
    validate_window(&window)?;
    begin_start(&shell)?;
    let shell = shell.inner().clone();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || finish_start(&app, &shell))
        .await
        .map_err(|_| "Backend restart task failed")?
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_failure(app: &tauri::AppHandle, message: &str) {
    show_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let encoded = serde_json::to_string(message).expect("string serialization");
        let _ = window.eval(&format!("window.__realmtoolShellFailure?.({encoded})"));
    }
}

fn quit(app: &tauri::AppHandle) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let mut backend = shell.backend.lock().unwrap_or_else(|e| e.into_inner());
        // A startup in progress will see `quitting` and dispose its own child.
        while backend.starting {
            backend = shell.ready.wait(backend).unwrap_or_else(|e| e.into_inner());
        }
        if let Some(mut child) = backend.child.take() {
            let _ = child.shutdown();
        }
        drop(backend);
        app.exit(0);
    });
}

// Native notice stays visible even when the webview is about to hide. No plugin,
// capability, filesystem access or notification permission is needed.
fn tray_notice() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }
    let text: Vec<u16> = "RealmTool will keep running in the system tray while the proxy is active. Use Show to reopen it or Quit to stop the backend.\0".encode_utf16().collect();
    let caption: Vec<u16> = "RealmTool is still running\0".encode_utf16().collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            0x40 | 0x10000,
        );
    }
}

fn close_window(app: &tauri::AppHandle) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if shell.quitting.load(Ordering::SeqCst) || shell.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let decision = {
            let mut backend = shell.backend.lock().unwrap_or_else(|e| e.into_inner());
            match backend.child.as_mut() {
                Some(child) => match child.has_exited() {
                    Ok(true) => Ok(false),
                    Ok(false) => child.proxy_running(),
                    Err(error) => Err(error),
                },
                None => Ok(false),
            }
        };
        match decision {
            Ok(true) => {
                if !shell.hide_notice_shown.swap(true, Ordering::SeqCst) { tray_notice(); }
                if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
            }
            Ok(false) => quit(&app),
            Err(_) => show_failure(&app, "Could not check whether the proxy is running. The window was kept open. Use Quit in the tray to stop RealmTool."),
        }
        shell.closing.store(false, Ordering::SeqCst);
    });
}

// Shell-owned recovery UI also works if the dashboard fails to initialize.
// All dynamic content is text; the token is never placed in the DOM or a URL.
fn recovery_script(log_path: &str) -> String {
    let path = serde_json::to_string(log_path).expect("string serialization");
    format!(
        r#"
(() => {{
  const invoke = (...args) => window.__TAURI_INTERNALS__.invoke(...args);
  const allowed = location.origin === 'http://tauri.localhost' || ({dev} && location.origin === 'http://localhost:5173');
  let pending;
  window.__realmtoolShellFailure = (message) => {{
    pending = message;
    if (!document.body) return;
    let dialog = document.getElementById('realmtool-shell-error');
    if (!dialog) {{
      dialog = document.createElement('dialog');
      dialog.id = 'realmtool-shell-error';
      const title = document.createElement('h1'); title.textContent = 'RealmTool backend';
      const details = document.createElement('p'); details.id = 'realmtool-shell-message';
      const logs = document.createElement('p'); logs.textContent = 'Log file: ' + {path};
      const retry = document.createElement('button'); retry.textContent = 'Retry';
      retry.addEventListener('click', async () => {{
        retry.disabled = true; details.textContent = 'Starting backend…';
        try {{ await invoke('restart_backend'); location.reload(); }}
        catch (error) {{ details.textContent = String(error); retry.disabled = false; }}
      }});
      const dismiss = document.createElement('button'); dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => dialog.close());
      dialog.append(title, details, logs, retry, dismiss); document.body.append(dialog);
    }}
    document.getElementById('realmtool-shell-message').textContent = message;
    if (!dialog.open) dialog.showModal();
  }};
  document.addEventListener('DOMContentLoaded', () => {{
    if (!allowed) {{ window.__realmtoolShellFailure('Unexpected window origin. Backend access is disabled.'); return; }}
    if (pending) window.__realmtoolShellFailure(pending);
    invoke('backend_info').catch(error => window.__realmtoolShellFailure(String(error)));
  }});
}})();
"#,
        dev = cfg!(debug_assertions)
    )
}

/// Debug builds only: the GUI smoke sets `REALMTOOL_GUI_SMOKE_CDP_PORT` to open the WebView2
/// DevTools protocol. wry passes explicit browser arguments, which current WebView2 runtimes
/// prefer over `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so the port goes in here. Explicit
/// arguments replace wry's defaults, so its disabled features are repeated.
#[cfg(debug_assertions)]
fn smoke_browser_args(port: Option<String>) -> Option<String> {
    let port = port?.parse::<u16>().ok().filter(|port| *port != 0)?;
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    ))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .manage(Arc::new(Shell::default()))
        .invoke_handler(tauri::generate_handler![backend_info, restart_backend])
        .setup(|app| {
            let log_path = app
                .path()
                .config_dir()?
                .join("RealmTool/logs/realmtool.log");
            let builder = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(trusted_origin)
                .initialization_script(recovery_script(&log_path.to_string_lossy()));
            #[cfg(debug_assertions)]
            let builder = match smoke_browser_args(std::env::var("REALMTOOL_GUI_SMOKE_CDP_PORT").ok()) {
                Some(args) => builder.additional_browser_args(&args),
                None => builder,
            };
            let window = builder.build()?;
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("realmtool")
                .tooltip("RealmTool")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "quit" => quit(app),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    close_window(&handle);
                }
            });
            let shell = app.state::<Arc<Shell>>().inner().clone();
            begin_start(&shell)?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(error) = finish_start(&handle, &shell) {
                    show_failure(&handle, &error);
                }
                while !shell.quitting.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(200));
                    let exited = {
                        let mut backend = shell.backend.lock().unwrap_or_else(|e| e.into_inner());
                        if backend
                            .child
                            .as_mut()
                            .is_some_and(|child| child.has_exited().unwrap_or(true))
                        {
                            backend.child.take();
                            backend.error =
                                Some("Backend exited unexpectedly. Retry to restart it.".into());
                            true
                        } else {
                            false
                        }
                    };
                    if exited && !shell.quitting.load(Ordering::SeqCst) {
                        let _ = handle.emit("backend-exited", ());
                        show_failure(&handle, "Backend exited unexpectedly. Retry to restart it.");
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building RealmTool");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Arc<Shell>>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                quit(app);
            }
        }
    });
}

#[cfg(all(test, debug_assertions))]
mod smoke_args_tests {
    use super::smoke_browser_args;

    #[test]
    fn opens_the_requested_debugging_port_and_keeps_wry_defaults() {
        assert_eq!(
            smoke_browser_args(Some("9241".into())).as_deref(),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9241")
        );
    }

    #[test]
    fn ignores_missing_zero_or_invalid_ports() {
        for value in [None, Some(""), Some("0"), Some("65536"), Some("-1"), Some("9241 --x"), Some("abc")] {
            assert_eq!(smoke_browser_args(value.map(String::from)), None, "{value:?}");
        }
    }
}
