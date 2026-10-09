. (Join-Path $PSScriptRoot 'tts-client.ps1')
if (Test-TtsMuted) { exit }

$data = Read-HookInput

if ($data -and $data.headline) {
    $msg = $data.headline
} else {
    $msg = if ($data -and $data.message) { $data.message.Trim() } else { 'The agent needs your attention.' }
    $where = Get-TtsWhere $data; if ($where) { $msg = "$msg $where" }
}

if (-not (Invoke-KokoroTts -Text (Clean-ForSpeech $msg) -Gender 'male')) { Add-TtsLog 'tts-failures.log' "speak: $msg" }
