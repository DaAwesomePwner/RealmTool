param(
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Directory,
  [int]$AppPid = 0
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$errors = [Collections.Generic.List[string]]::new()
function Capture([string]$Name, [scriptblock]$Work) {
  "$(Get-Date -Format o) start $Name" | Add-Content -LiteralPath (Join-Path $Directory 'collector-progress.log')
  try { & $Work } catch { $errors.Add("${Name}: $($_.Exception.Message)") }
  "$(Get-Date -Format o) end $Name" | Add-Content -LiteralPath (Join-Path $Directory 'collector-progress.log')
}
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
# This helper inherits the runner's interactive session. Never switch sessions or change the host.
Capture 'desktop' {
  @{ sessionId = $sessionId; expectedSessionId = 1; userInteractive = [Environment]::UserInteractive } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'desktop-session.json')
  if ($sessionId -ne 1) { throw "Desktop capture requires session 1; collector is in session $sessionId" }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type 'using System.Runtime.InteropServices; public static class SmokeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
  [SmokeDpi]::SetProcessDPIAware() | Out-Null
  $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size, [Drawing.CopyPixelOperation]::SourceCopy)
      $bitmap.Save((Join-Path $Directory 'desktop.png'), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose() }
  } finally { $bitmap.Dispose() }
}
$processes = @()
$listeners = @()
$rootAlive = $false
$exitCode = $null
Capture 'processes' {
  $script:processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 8 |
    Select-Object Name, ProcessId, ParentProcessId, SessionId, ExecutablePath, CommandLine, CreationDate)
  # CIM retains children even if the launched parent already exited.
  $script:rootAlive = @($script:processes | Where-Object ProcessId -EQ $AppPid).Count -gt 0
}
Capture 'listeners' {
  $script:listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Select-Object LocalAddress, LocalPort, OwningProcess)
}
Capture 'temporary-profile' {
  # PowerShell does not recurse through directory links without -FollowSymlink.
  @(Get-ChildItem -LiteralPath $Root -Recurse -Force |
    Select-Object FullName, Length, Attributes, LastWriteTimeUtc, LinkTarget) |
    ConvertTo-Json -Depth 5 -AsArray | Set-Content -LiteralPath (Join-Path $Directory 'temporary-profile.json')
}
Capture 'application-logs' {
  $logPaths = @(
    @{ source = (Join-Path $Root 'roaming/RealmTool/logs/realmtool.log'); artifact = 'app-temp.log' },
    @{ source = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'RealmTool/logs/realmtool.log'); artifact = 'app-real-config.log' }
  )
  foreach ($log in $logPaths) {
    $log.exists = Test-Path -LiteralPath $log.source -PathType Leaf
    if ($log.exists) {
      # Read only: the destination is always the diagnostics folder, never a real known folder.
      Capture $log.artifact { Copy-Item -LiteralPath $log.source -Destination (Join-Path $Directory $log.artifact) }
    }
  }
  $logPaths | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'application-log-paths.json')
}
@{ processes = @($processes); listeners = @($listeners); errors = @($errors.ToArray());
   sessionId = $sessionId; rootAlive = $rootAlive; exitCode = $exitCode } | ConvertTo-Json -Depth 6 -Compress
