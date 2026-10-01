. (Join-Path $PSScriptRoot 'tts-client.ps1')
if (Test-TtsMuted) { exit }

$raw  = [Console]::In.ReadToEnd()
$data = try { $raw | ConvertFrom-Json } catch { $null }

$msg = if ($data -and $data.last_assistant_message) { $data.last_assistant_message.Trim() } else { 'The agent is done.' }

# Pull out an "Insights" section so it survives truncation and is spoken last.
$insightsText = $null
if ($msg -match '(?ms)(^#{1,6}\s*Insights\s*\r?\n(.*?)(?=^#{1,6}\s|\z))') {
    $fullBlock = $Matches[1]
    $insightsText = (Clean-ForSpeech ($Matches[2].Trim()) -replace '\s+', ' ').Trim()
    $msg = $msg.Remove($msg.IndexOf($fullBlock), $fullBlock.Length).Trim()
}

$msg = Clean-ForSpeech $msg
$where = Get-TtsWhere $data; if ($where) { $msg = "$msg ... $where;" }
if ($insightsText) { $msg = "$msg ... Insights : $insightsText." }

if (-not (Invoke-KokoroTts -Text $msg -Gender 'male')) { Add-TtsLog 'tts-failures.log' "stop-speak: $msg" }
