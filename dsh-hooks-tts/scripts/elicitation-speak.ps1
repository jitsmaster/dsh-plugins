. (Join-Path $PSScriptRoot 'tts-client.ps1')
if (Test-TtsMuted) { exit }

$data = Read-HookInput

if ($data -and $data.headline) {
    $msg = $data.headline
} else {
    if ($data -and $data.tool_input -and $data.tool_input.questions) {
        $msg = ($data.tool_input.questions | ForEach-Object { $_.question }) -join '. '
        if ([string]::IsNullOrWhiteSpace($msg)) { $msg = 'We have a question for you' }
    } elseif ($data -and $data.message) {
        $msg = $data.message.Trim()
    } else {
        $msg = 'The agent has a question for you.'
    }
    $where = Get-TtsWhere $data; if ($where) { $msg = "$msg $where" }
}

if (-not (Invoke-KokoroTts -Text (Clean-ForSpeech $msg) -Gender 'female' -Priority High)) { Add-TtsLog 'tts-failures.log' "elicitation-speak: $msg" }
