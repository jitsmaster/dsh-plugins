. (Join-Path $PSScriptRoot 'tts-client.ps1')
if (Test-TtsMuted) { exit }

$raw  = [Console]::In.ReadToEnd()
$data = try { $raw | ConvertFrom-Json } catch { $null }

$msg = if ($data -and $data.message) { $data.message.Trim() } else { 'The agent needs your attention.' }
$where = Get-TtsWhere $data; if ($where) { $msg = "$msg $where" }

if (-not (Invoke-KokoroTts -Text $msg -Gender 'male')) { Add-TtsLog 'tts-failures.log' "speak: $msg" }
