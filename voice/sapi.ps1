param(
    [Parameter(Mandatory=$true)][string]$TextFile,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$Voice = 'Microsoft Yaoyao',
    [int]$Rate = 2
)
# 离线兜底：Windows 自带 SAPI（Huihui / Yaoyao）。音质不如 edge-tts，但完全不依赖网络。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
if (-not $text.Trim()) { Write-Error 'EMPTY_TEXT'; exit 2 }
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voice) } catch { }
$s.Rate = $Rate
$s.SetOutputToWaveFile($Out)
$s.Speak($text)
$s.Dispose()
if (-not (Test-Path $Out)) { Write-Error 'NO_OUTPUT'; exit 3 }
"OK $((Get-Item $Out).Length)"
