. (Join-Path $PSScriptRoot 'tts-client.ps1')
if (Test-TtsMuted) { exit }

$data = Read-HookInput

# Only the short headline built by the plugin is spoken, never the whole response.
$msg = if ($data -and $data.headline) { $data.headline } else { 'Done.' }

if (-not (Invoke-KokoroTts -Text (Clean-ForSpeech $msg) -Gender 'male')) { Add-TtsLog 'tts-failures.log' "stop-speak: $msg" }
