# Persistent speak worker for the voice flow (docs/voice-two-stage-flow.md section 2).
# stdin:  one UTF-8 JSON request per line: {"id":n,"text":"...","gender":"female","priority":"High"}
# stdout: JSON lines only: {"ready":true} once, then per request {"id":n,"event":"start"} right before playback and
#         {"id":n,"status":"done"|"failed","ms":n}. EOF on stdin -> exit 0.
# The voice flow is user-initiated, so tts-muted.flag is deliberately NOT checked; Ctrl+Alt+M (tts-stop.flag) still
# cuts the current line short inside Invoke-KokoroTts.
. (Join-Path $PSScriptRoot 'tts-client.ps1')

function Write-WorkerLine([string]$Json) {
    [Console]::Out.WriteLine($Json)
    [Console]::Out.Flush()
}

Write-WorkerLine '{"ready":true}'

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $workerReqId = $null
    $ok = $false
    try {
        $req = $line | ConvertFrom-Json
        $workerReqId = $req.id
        $gender = if ($req.gender -in @('male', 'female')) { [string]$req.gender } else { 'female' }
        $priority = if ($req.priority -in @('High', 'Normal')) { [string]$req.priority } else { 'High' }
        $idJson = $workerReqId | ConvertTo-Json -Compress
        # Runs inside Invoke-KokoroTts right before playback; writes straight to stdout so nothing leaks into its result.
        $onStart = { [Console]::Out.WriteLine('{"id":' + $idJson + ',"event":"start"}'); [Console]::Out.Flush() }
        $ok = [bool](Invoke-KokoroTts -Text (Clean-ForSpeech ([string]$req.text)) -Gender $gender -Priority $priority -OnPlaybackStart $onStart)
    } catch {
        Add-TtsLog 'tts-client-errors.log' "speak-worker: $($_.Exception.Message)"
        $ok = $false
    }
    if ($null -eq $workerReqId) { continue }
    $status = if ($ok) { 'done' } else { 'failed' }
    Write-WorkerLine ('{"id":' + ($workerReqId | ConvertTo-Json -Compress) + ',"status":"' + $status + '","ms":' + [int]$sw.ElapsedMilliseconds + '}')
}
exit 0
