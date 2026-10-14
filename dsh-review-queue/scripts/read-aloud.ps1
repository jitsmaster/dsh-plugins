# Speaks the chunks given as UTF-8 JSON on stdin ({"chunks":[...]}) one after the other through dsh-hooks-tts's
# tts-client.ps1 (Kokoro server, playback mutex, stop hotkey). Killing this process stops the speech.
# Kept pure ASCII: Windows PowerShell 5.1 misreads BOM-less UTF-8 source.
param(
    [Parameter(Mandatory)][string]$ClientScript,
    [ValidateSet('male', 'female')][string]$Gender = 'male'
)
$ErrorActionPreference = 'Stop'
. $ClientScript
$data = Read-HookInput
foreach ($chunk in @($data.chunks)) {
    $text = Clean-ForSpeech ([string]$chunk)
    if (-not $text.Trim()) { continue }
    if (-not (Invoke-KokoroTts -Text $text -Gender $Gender)) { exit 2 }
}
