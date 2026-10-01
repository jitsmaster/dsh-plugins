# Stops the current TTS read immediately without muting future reads.
$dir = if ($env:DSH_TTS_STATE_DIR) { $env:DSH_TTS_STATE_DIR } else { Join-Path $env:TEMP 'dsh-tts' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Item (Join-Path $dir 'tts-stop.flag') -ItemType File -Force | Out-Null
Write-Host 'Cancel signalled'
