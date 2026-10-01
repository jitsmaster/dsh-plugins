# Toggles TTS mute and stops any read currently playing.
$dir = if ($env:DSH_TTS_STATE_DIR) { $env:DSH_TTS_STATE_DIR } else { Join-Path $env:TEMP 'dsh-tts' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$muteFlag = Join-Path $dir 'tts-muted.flag'
if (Test-Path $muteFlag) {
    Remove-Item $muteFlag -Force
    Write-Host 'TTS unmuted'
} else {
    New-Item $muteFlag -ItemType File -Force | Out-Null
    New-Item (Join-Path $dir 'tts-stop.flag') -ItemType File -Force | Out-Null
    Write-Host 'TTS muted'
}
