# watchdog.ps1 —— 心跳判活；桥接不在就（经隐藏 vbs）拉起。由计划任务每 3 分钟调用。
# 判据只看两件事：heartbeat.json 是否新鲜、里面记的 pid 是否还活着。不动别的东西。
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [int]$StaleSeconds = 90
)

$ErrorActionPreference = 'Continue'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$hb = Join-Path $RepoRoot 'heartbeat.json'
$bin = Join-Path $env:LOCALAPPDATA 'dsh-qq-bridge'
$logDir = $bin
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'

function Write-Log([string]$msg) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $log -Value $line -Encoding UTF8
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$ageSec = $null
$pidAlive = $false
$recordedPid = 0

if (Test-Path $hb) {
  try {
    $j = Get-Content $hb -Raw | ConvertFrom-Json
    $ts = [double]$j.ts
    if ($ts -gt 0) { $ageSec = [Math]::Round(($now - $ts) / 1000, 1) }
    $recordedPid = [int]$j.pid
    if ($recordedPid -gt 0) {
      try {
        Get-Process -Id $recordedPid -ErrorAction Stop | Out-Null
        $pidAlive = $true
      } catch {
        # EPERM 之类也说明进程可能存在；用 CIM 再确认一次
        $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $recordedPid) -ErrorAction SilentlyContinue
        if ($p) { $pidAlive = $true }
      }
    }
  } catch {
    Write-Log ("心跳文件无法解析：" + $_.Exception.Message)
  }
}

if ($null -ne $ageSec -and $ageSec -lt $StaleSeconds) {
  # 新鲜：什么都不做，也不写日志（避免每 3 分钟刷一行）
  exit 0
}

if ($pidAlive) {
  Write-Log ("心跳已 " + $ageSec + "s 未更新，但 pid " + $recordedPid + " 仍存在 —— 可能卡住，先不动（人工检查）")
  exit 0
}

$startVbs = Join-Path $bin 'start-hidden.vbs'
if (-not (Test-Path $startVbs)) {
  Write-Log ("找不到 " + $startVbs + "，先运行 scripts\install-tasks.ps1")
  exit 1
}

Write-Log ("桥接不在（心跳年龄 " + $ageSec + "s，pid=" + $recordedPid + "），拉起")
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $startVbs + '"') -WindowStyle Hidden
exit 0
