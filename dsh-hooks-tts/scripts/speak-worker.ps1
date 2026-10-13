# Persistent speak worker for the voice flow (docs/voice-two-stage-flow.md section 2).
# stdin:  one UTF-8 JSON request per line: {"id":n,"text":"...","gender":"female","priority":"High"}
# stdout: JSON lines only: {"ready":true} once, then per request {"id":n,"event":"start","durationMs":n} right before
#         playback (durationMs = WAV length, omitted when unknown; speaker.js times playback with it) and
#         {"id":n,"status":"done"|"failed","ms":n}. EOF on stdin -> exit 0.
# The voice flow is user-initiated, so tts-muted.flag is deliberately NOT checked; Ctrl+Alt+M (tts-stop.flag) still
# cuts the current line short inside Invoke-KokoroTts. -NoPidFile keeps the worker's PID out of audio.pids, so the hotkey
# never kills the worker itself (a cut line still reports "done").
# Barge-in: while a line is spoken the worker cannot read stdin, so the plugin cancels the lines queued behind it with
# <state dir>\tts-voice-cancel.json {"before":N}: a line with id < N that has not begun is answered
# {"id":n,"status":"cancelled","ms":0} without synthesis or playback. The line in flight is cut through tts-stop.flag.
. (Join-Path $PSScriptRoot 'tts-client.ps1')

function Write-WorkerLine([string]$Json) {
    [Console]::Out.WriteLine($Json)
    [Console]::Out.Flush()
}

# A worker killed mid-line (timeout or stop) skips Invoke-KokoroTts's finally block and can leave the High-priority flag
# behind, which makes Normal-priority hook read-outs wait up to 20 s. A new worker clears it before taking any line.
Remove-Item -Path (Join-Path $script:TtsStateDir 'tts-priority-pending.flag') -Force -ErrorAction SilentlyContinue

# The cancel marker is only valid for the plugin session that wrote it; request ids restart at 1 with every plugin
# start, so a marker older than this process (a previous session's, or one written before this worker was spawned)
# would wrongly skip fresh lines. One written after this process started is kept.
$script:CancelMarker = Join-Path $script:TtsStateDir 'tts-voice-cancel.json'
try {
    $startedAt = (Get-Process -Id $PID).StartTime
    if ((Test-Path $script:CancelMarker) -and ((Get-Item $script:CancelMarker).LastWriteTime -lt $startedAt)) {
        Remove-Item -Path $script:CancelMarker -Force -ErrorAction SilentlyContinue
    }
} catch { }

# True when the plugin cancelled this request id (a barge-in happened while it was still queued).
function Test-VoiceCancelled($Id) {
    try {
        if (-not (Test-Path $script:CancelMarker)) { return $false }
        $marker = Get-Content -Raw -Path $script:CancelMarker | ConvertFrom-Json
        return ([double]$Id -lt [double]$marker.before)
    } catch { return $false }
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
    $cancelled = $false
    try {
        $req = $line | ConvertFrom-Json
        $workerReqId = $req.id
        if (Test-VoiceCancelled $workerReqId) { $cancelled = $true; throw 'cancelled' }
        $gender = if ($req.gender -in @('male', 'female')) { [string]$req.gender } else { 'female' }
        $priority = if ($req.priority -in @('High', 'Normal')) { [string]$req.priority } else { 'High' }
        $idJson = $workerReqId | ConvertTo-Json -Compress
        # Runs inside Invoke-KokoroTts right before playback; writes straight to stdout so nothing leaks into its result.
        $onStart = {
            param($Seconds)
            $dur = if ($Seconds) { ',"durationMs":' + [int][math]::Round([double]$Seconds * 1000) } else { '' }
            [Console]::Out.WriteLine('{"id":' + $idJson + ',"event":"start"' + $dur + '}'); [Console]::Out.Flush()
        }
        $ok = [bool](Invoke-KokoroTts -Text (Clean-ForSpeech ([string]$req.text)) -Gender $gender -Priority $priority -OnPlaybackStart $onStart -NoPidFile)
    } catch {
        if (-not $cancelled) { Add-TtsLog 'tts-client-errors.log' "speak-worker: $($_.Exception.Message)" }
        $ok = $false
    }
    if ($null -eq $workerReqId) { continue }
    $status = if ($cancelled) { 'cancelled' } elseif ($ok) { 'done' } else { 'failed' }
    Write-WorkerLine ('{"id":' + ($workerReqId | ConvertTo-Json -Compress) + ',"status":"' + $status + '","ms":' + [int]$sw.ElapsedMilliseconds + '}')
}
exit 0
