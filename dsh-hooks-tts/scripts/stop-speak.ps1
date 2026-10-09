. (Join-Path $PSScriptRoot 'tts-client.ps1')
if (Test-TtsMuted) { exit }

$data = Read-HookInput

# Only the short headline built by the plugin is spoken, never the whole response.
if ($data -and $data.headline) {
    $msg = $data.headline
} else {
    # No headline from the plugin: still say where, but never the response itself.
    $msg = 'Done'
    $where = @()
    if ($data -and $data.session_title) { $where += ('Session: ' + $data.session_title) }
    if ($data -and $data.cwd) { $leaf = Split-Path -Leaf ([string]$data.cwd).TrimEnd('\', '/'); if ($leaf) { $where += ('Workspace: ' + $leaf) } }
    if ($where.Count) { $msg += ' on: ' + ($where -join '; ') }
    $msg += '.'
}

if (-not (Invoke-KokoroTts -Text (Clean-ForSpeech $msg) -Gender 'male')) { Add-TtsLog 'tts-failures.log' "stop-speak: $msg" }
