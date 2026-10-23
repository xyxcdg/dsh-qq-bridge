# qq-selfheal.ps1 - account-level self healing for the QQ bot.
# ASCII only on purpose (BOM-less UTF-8 vs GBK bug class).
# Called by qq-stack-watchdog.ps1 right after the port/heartbeat checks.
# Ports listening does NOT mean the QQ account can talk: when the account goes
# offline the OneBot ws stays up and the bridge heartbeat stays fresh, so the
# old watchdog considered everything healthy. This script probes the account
# itself (get_login_info + get_status), and when it is offline it kills the
# half-dead NapCat and relaunches it, then notifies every group and user.
$ErrorActionPreference = 'SilentlyContinue'
# 三个位置都可用环境变量覆盖；默认按脚本自身位置与 PATH 推断。
$root = if ($env:QQ_BOT_ROOT) { $env:QQ_BOT_ROOT } else { Split-Path -Parent $PSScriptRoot }
$log = Join-Path $root 'selfheal.log'
$restartStamp = Join-Path $root 'selfheal-restart.stamp'
$launchStamp = Join-Path $root 'watchdog-napcat.stamp'
# NapCat 的隐藏启动脚本（每台机器路径不同）；没配就只做探测、不重启。
$napcatVbs = if ($env:QQ_BOT_NAPCAT_VBS) { $env:QQ_BOT_NAPCAT_VBS } else { '' }
$probeJs = Join-Path $root 'qq-probe.cjs'
$notifyJs = Join-Path $root 'qq-notify-all.cjs'
$node = if ($env:QQ_BOT_NODE) { $env:QQ_BOT_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }

function Say($m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
  if ((Get-Item $log).Length -gt 1MB) {
    $tail = Get-Content $log -Tail 300
    Set-Content -LiteralPath $log -Value $tail -Encoding utf8
  }
}
function Probe {
  try {
    $raw = & $node $probeJs 2>$null
    if (-not $raw) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

# grace window: NapCat was just launched, login takes ~40s - do not probe yet
if (Test-Path $launchStamp) {
  $ageMin = ((Get-Date) - (Get-Item $launchStamp).LastWriteTime).TotalMinutes
  if ($ageMin -lt 4) {
    Say ('skip probe: napcat launched ' + [int]$ageMin + ' min ago, login in progress')
    exit 0
  }
}

$hardStamp = Join-Path $root 'selfheal-hardcool.stamp'
$failFile  = Join-Path $root 'selfheal-fails.txt'
if (Test-Path $hardStamp) {
  $hm = ((Get-Date) - (Get-Item $hardStamp).LastWriteTime).TotalMinutes
  if ($hm -lt 30) {
    Say ('hard cooldown after repeated failures (' + [int]$hm + ' min < 30), skip')
    exit 0
  }
  Remove-Item -LiteralPath $hardStamp -Force
  Set-Content -LiteralPath $failFile -Value '0' -Encoding utf8
}

$p = Probe
if ($p -and $p.ok -and $p.online) {
  Say ('online ok: ' + $p.nickname + ' (' + $p.userId + ')')
  Set-Content -LiteralPath $failFile -Value '0' -Encoding utf8
  exit 0
}
$detail = if ($p) { ($p | ConvertTo-Json -Compress) } else { 'probe returned nothing' }
Say ('ACCOUNT OFFLINE/UNREACHABLE: ' + $detail)

# cooldown: at most one relaunch per 5 minutes
if (Test-Path $restartStamp) {
  $cool = ((Get-Date) - (Get-Item $restartStamp).LastWriteTime).TotalMinutes
  if ($cool -lt 5) {
    Say ('restart cooldown (' + [int]$cool + ' min), skip')
    exit 0
  }
}
Set-Content -LiteralPath $restartStamp -Value (Get-Date -Format o) -Encoding utf8

# kill the half-dead NapCat (and any QQ child it spawned), then relaunch
$killed = @()
$np = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*napcat-node*' }).ProcessId
foreach ($id in $np) {
  try { Stop-Process -Id $id -Force -ErrorAction Stop; $killed += $id }
  catch { Say ('kill node ' + $id + ' failed: ' + $_.Exception.Message) }
}
$qq = (Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.CommandLine -like '*napcat-node*' }).ProcessId
foreach ($id in $qq) {
  try { Stop-Process -Id $id -Force -ErrorAction Stop; $killed += $id } catch {}
}
Say ('killed pids: ' + ($killed -join ',') + ' (napcat=' + ($np -join ',') + ' qq=' + ($qq -join ',') + ')')
Start-Sleep -Seconds 3
if (-not $napcatVbs -or -not (Test-Path $napcatVbs)) {
  Say 'napcat relaunch skipped: QQ_BOT_NAPCAT_VBS not configured or missing'
  exit 1
}
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $napcatVbs + '"') -WindowStyle Hidden
Say 'napcat relaunched, waiting 45s for login'
Start-Sleep -Seconds 45

$p2 = Probe
if ($p2 -and $p2.ok -and $p2.online) {
  Say ('HEALED: ' + $p2.nickname + ' (' + $p2.userId + '); bridge reconnects on its own')
  Start-Sleep -Seconds 8
  $n = & $node $notifyJs '--reason=selfheal' 2>$null
  Say ('notify: ' + ($n -join ' '))
} else {
  $d2 = if ($p2) { ($p2 | ConvertTo-Json -Compress) } else { 'probe returned nothing' }
  $fails = 0
  try { $fails = [int](Get-Content -LiteralPath $failFile -Raw) } catch { $fails = 0 }
  $fails = $fails + 1
  Set-Content -LiteralPath $failFile -Value ([string]$fails) -Encoding utf8
  Say ('STILL OFFLINE after relaunch (fail #' + $fails + '): ' + $d2)
  if ($fails -ge 3) {
    Set-Content -LiteralPath $hardStamp -Value (Get-Date -Format o) -Encoding utf8
    Say 'gave up for now: 3 consecutive failures -> 30 min hard cooldown (avoid kicking each other)'
  }
}
