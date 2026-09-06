param(
  [ValidateSet('start', 'stop', 'restart')]
  [string]$Action = 'start',
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [Parameter(Mandatory = $true)]
  [string]$StateDirectory,
  [Parameter(Mandatory = $true)]
  [string]$EdgeProfile,
  [Parameter(Mandatory = $true)]
  [string]$Url,
  [int]$ApiPort = 9100,
  [int]$WebPort = 9102
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null

$apiPidFile = Join-Path $StateDirectory 'mes-api.pid'
$webPidFile = Join-Path $StateDirectory 'mes-web.pid'

function Test-Http([string]$TargetUrl) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $TargetUrl -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Stop-Tree([string]$PidFile) {
  if (-not (Test-Path -LiteralPath $PidFile)) { return }
  $processId = 0
  [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$processId) | Out-Null
  if ($processId -gt 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $processId /T /F *> $null
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-ManagedService([string]$Name, [string]$WorkingDirectory, [string]$Command, [string]$PidFile, [string]$ProbeUrl) {
  if (Test-Http $ProbeUrl) {
    Write-Output "$Name is already running."
    return
  }

  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $Command) -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii

  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    if (Test-Http $ProbeUrl) {
      Write-Output "$Name started."
      return
    }
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become ready at $ProbeUrl."
}

function Get-EdgePath() {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Get-WallboardWindow() {
  $profilePattern = [regex]::Escape($EdgeProfile)
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match $profilePattern }
  foreach ($processInfo in $processes) {
    $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { return $process }
  }
  return $null
}

function Move-And-Maximize([System.Diagnostics.Process]$Process, [System.Drawing.Rectangle]$Area) {
  if (-not ('WallboardNative' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WallboardNative {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
  }
  [WallboardNative]::SetWindowPos($Process.MainWindowHandle, [IntPtr]::Zero, $Area.X, $Area.Y, $Area.Width, $Area.Height, 0x0004) | Out-Null
  [WallboardNative]::ShowWindow($Process.MainWindowHandle, 3) | Out-Null
}

function Stop-Wallboard() {
  Stop-Tree $webPidFile
  Stop-Tree $apiPidFile
  $profilePattern = [regex]::Escape($EdgeProfile)
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $profilePattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Output 'Wallboard stopped.'
}

if ($Action -eq 'stop') {
  Stop-Wallboard
  exit 0
}
if ($Action -eq 'restart') {
  Stop-Wallboard
  Start-Sleep -Milliseconds 500
}

Add-Type -AssemblyName System.Windows.Forms
$secondary = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $secondary) {
  throw 'No secondary monitor was detected. Wallboard was not started.'
}
# Cover the complete secondary display, including the taskbar area.
$area = $secondary.Bounds

Start-ManagedService 'MES API' (Join-Path $Root 'Mes.Api') "dotnet run --no-launch-profile --urls http://0.0.0.0:$ApiPort" $apiPidFile "http://127.0.0.1:$ApiPort/api/health"
Start-ManagedService 'MES Web' (Join-Path $Root 'scada-web') "npm.cmd run dev -- --host 0.0.0.0 --port $WebPort" $webPidFile "http://127.0.0.1:$WebPort/"

$edgePath = Get-EdgePath
if (-not $edgePath) { throw 'Microsoft Edge was not found.' }
$window = Get-WallboardWindow
if (-not $window) {
  $edgeArguments = @(
    "--user-data-dir=$EdgeProfile",
    "--app=$Url",
    '--start-maximized',
    '--start-fullscreen',
    "--window-position=$($area.X),$($area.Y)",
    "--window-size=$($area.Width),$($area.Height)",
    '--no-first-run',
    '--no-default-browser-check'
  )
  Start-Process -FilePath $edgePath -ArgumentList $edgeArguments | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $window = Get-WallboardWindow
    if ($window) { break }
    Start-Sleep -Milliseconds 250
  }
}
if (-not $window) { throw 'Edge Wallboard window did not become ready.' }
Move-And-Maximize $window $area
Write-Output "Wallboard is running on the secondary monitor at $Url."
