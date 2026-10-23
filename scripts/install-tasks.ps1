# install-tasks.ps1 —— 注册/卸载 Windows 计划任务：登录隐藏启动桥接 + 每 3 分钟看门狗。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1 -RunLevel Highest
#   powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1 -Uninstall
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$NodeExe = '',
  [string]$TaskPrefix = 'QQBot',
  [ValidateSet('Limited', 'Highest')][string]$RunLevel = 'Limited',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$bridge = Join-Path $RepoRoot 'bridge.js'
$config = Join-Path $RepoRoot 'bridge.config.json'
$watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'
$bin = Join-Path $env:LOCALAPPDATA 'dsh-qq-bridge'
$startVbs = Join-Path $bin 'start-hidden.vbs'
$wdVbs = Join-Path $bin 'watchdog-hidden.vbs'
$bridgeTask = "$TaskPrefix-Bridge"
$watchTask = "$TaskPrefix-Watchdog"

function Remove-OurTasks {
  foreach ($n in @($bridgeTask, $watchTask)) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if ($t) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host "[OK] 已删除任务 $n"
    } else {
      Write-Host "[--] 任务不存在：$n"
    }
  }
}

if ($Uninstall) {
  Remove-OurTasks
  Write-Host "窗口脚本保留在 $bin（下次安装会重建）。"
  return
}

if (-not (Test-Path $bridge)) { throw "找不到 $bridge" }
if (-not (Test-Path $config)) { throw "找不到 $config；先复制 bridge.config.example.json 为 bridge.config.json 再改。" }
if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe -or -not (Test-Path $NodeExe)) { throw "找不到 node.exe；用 -NodeExe 指定完整路径。" }

New-Item -ItemType Directory -Force -Path $bin | Out-Null

# VBS 必须 UTF-16LE + BOM：含中文路径时 wscript 才会正确解析。
$utf16 = New-Object System.Text.UnicodeEncoding($false, $true)
$startLines = @(
  'Set sh = CreateObject("WScript.Shell")',
  ('sh.CurrentDirectory = "' + $RepoRoot + '"'),
  ('sh.Run """' + $NodeExe + '"" ""' + $bridge + '""", 0, False')
)
[System.IO.File]::WriteAllLines($startVbs, $startLines, $utf16)

$wdLines = @(
  'Set sh = CreateObject("WScript.Shell")',
  ('sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + $watchdog + '""", 0, False')
)
[System.IO.File]::WriteAllLines($wdVbs, $wdLines, $utf16)

# 任务动作永远是 wscript + 隐藏 vbs；直接写 node/powershell 会在登录时闪一个控制台窗口。
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $RunLevel
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

$t1 = New-ScheduledTaskTrigger -AtLogOn -User $user
$a1 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $startVbs + '"')
Register-ScheduledTask -TaskName $bridgeTask -Action $a1 -Trigger $t1 -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "[OK] 已注册 $bridgeTask（登录时隐藏启动，RunLevel=$RunLevel）"

$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3) -RepetitionDuration (New-TimeSpan -Days 3650)
$a2 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $wdVbs + '"')
Register-ScheduledTask -TaskName $watchTask -Action $a2 -Trigger $t2 -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "[OK] 已注册 $watchTask（每 3 分钟检查心跳）"

Get-ScheduledTask -TaskName $bridgeTask, $watchTask | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ""
Write-Host "窗口脚本：$startVbs"
Write-Host "看门狗日志：$bin\watchdog.log"
Write-Host "立即试一次：Start-ScheduledTask -TaskName $bridgeTask"
