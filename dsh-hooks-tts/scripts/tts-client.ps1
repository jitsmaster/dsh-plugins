$script:TtsStateDir = if ($env:DSH_TTS_STATE_DIR) { $env:DSH_TTS_STATE_DIR } else { Join-Path $env:TEMP 'dsh-tts' }
$script:TtsUrl = if ($env:DSH_TTS_URL) { $env:DSH_TTS_URL } else { 'http://127.0.0.1:8880/tts' }
New-Item -ItemType Directory -Force -Path $script:TtsStateDir | Out-Null

function Test-TtsMuted { Test-Path (Join-Path $script:TtsStateDir 'tts-muted.flag') }

# State kept across calls, so a long-lived caller (speak-worker.ps1) does not repeat per-line work: the shared HttpClient, the
# one-time assembly load, when the server was last seen up, when the hotkey was last checked. (A failed server start is
# remembered in the state dir instead: every alert script is a fresh process.)
$script:TtsHttp = $null
$script:TtsHttpWarm = $false   # the client has completed a request, so a pooled connection may exist
$script:TtsNetLoaded = $false
$script:TtsServerOkAt = $null
$script:TtsHotkeyCheckedAt = $null
$script:TtsServerTrustSeconds = 30
$script:TtsStartRetrySeconds = 60

function Get-TtsStartFailedPath { Join-Path $script:TtsStateDir 'tts-start-failed.flag' }

# True when a server start failed less than $script:TtsStartRetrySeconds ago (in any process: the flag file's mtime).
# A negative age (the clock was set back, or the file is dated in the future) is stale: otherwise the backoff would never expire.
function Test-TtsStartRecentlyFailed {
    $item = Get-Item -Path (Get-TtsStartFailedPath) -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    $age = ((Get-Date) - $item.LastWriteTime).TotalSeconds
    return [bool]($age -ge 0 -and $age -lt $script:TtsStartRetrySeconds)
}

# How long to wait for a started server: DSH_TTS_START_WAIT_SECONDS clamped to 1..300 seconds (unparsable or empty: 90). An env
# value is untrusted enough that 0 must not skip the wait's purpose and a huge value must not hold the mutex (and every hook) for hours.
function Get-TtsStartWaitSeconds {
    $waitSeconds = 0
    if (-not [int]::TryParse($env:DSH_TTS_START_WAIT_SECONDS, [ref]$waitSeconds)) { return 90 }
    return [Math]::Min(300, [Math]::Max(1, $waitSeconds))
}

function Set-TtsServerUp {
    $script:TtsServerOkAt = Get-Date
    Remove-Item -Path (Get-TtsStartFailedPath) -Force -ErrorAction SilentlyContinue
}

function Get-TtsHttpClient {
    if (-not $script:TtsNetLoaded) { Add-Type -AssemblyName System.Net.Http; $script:TtsNetLoaded = $true }
    if (-not $script:TtsHttp) {
        $script:TtsHttp = New-Object System.Net.Http.HttpClient
        $script:TtsHttp.Timeout = [TimeSpan]::FromSeconds(30)
    }
    return $script:TtsHttp
}

# A pooled connection the server closed while idle fails the next request: throw the client away so the retry opens a new one.
function Remove-TtsHttpClient {
    if ($script:TtsHttp) { $script:TtsHttp.Dispose(); $script:TtsHttp = $null }
    $script:TtsHttpWarm = $false
}

function Add-TtsLog([string]$File, [string]$Line) {
    Add-Content -Path (Join-Path $script:TtsStateDir $File) -Value "$(Get-Date -Format o) $Line"
}

function Test-TtsPort {
    $u = [Uri]$script:TtsUrl
    $c = New-Object System.Net.Sockets.TcpClient
    try { return $c.ConnectAsync($u.Host, $u.Port).Wait(1500) -and $c.Connected } catch { return $false } finally { $c.Dispose() }
}

# Keep the Ctrl+Alt+M stop-hotkey listener alive alongside the TTS server: start it if it is not running.
# Prefers the TtsStopHotkey scheduled task, falls back to launching the exe directly.
function Start-TtsHotkeyIfDown {
    # Checked at most once a minute: a process lookup per spoken line is wasted work.
    if ($script:TtsHotkeyCheckedAt -and ((Get-Date) - $script:TtsHotkeyCheckedAt).TotalSeconds -lt 60) { return }
    $script:TtsHotkeyCheckedAt = Get-Date
    try {
        $hotDir = if ($env:DSH_TTS_HOTKEY_DIR) { $env:DSH_TTS_HOTKEY_DIR } else { Join-Path $env:USERPROFILE '.claude' }
        $exe = Join-Path $hotDir 'tts-stop-hotkey.exe'
        if (-not (Test-Path $exe)) { return }
        if (Get-Process -Name 'tts-stop-hotkey' -ErrorAction SilentlyContinue) { return }
        Add-TtsLog 'tts-client-errors.log' 'hotkey listener down; starting'
        try { Start-ScheduledTask -TaskName 'TtsStopHotkey' -ErrorAction Stop }
        catch { Start-Process -FilePath $exe -WindowStyle Hidden }
    } catch {
        Add-TtsLog 'tts-client-errors.log' "hotkey start failed: $($_.Exception.Message)"
    }
}

# If the Kokoro server is not listening, launch it (DSH_TTS_SERVER_SCRIPT) and wait for the port.
# A named mutex keeps concurrent hook runs from launching it twice.
# A server seen up in the last $script:TtsServerTrustSeconds is not probed again, and a start that did not bring it up is not
# repeated (nor waited for) for $script:TtsStartRetrySeconds: otherwise every line would block for the full wait while it is down.
# Returns $false only when the server is known to be down (a start just failed): the caller then skips the request.
function Start-TtsServerIfDown {
    Start-TtsHotkeyIfDown
    if ($script:TtsServerOkAt -and ((Get-Date) - $script:TtsServerOkAt).TotalSeconds -lt $script:TtsServerTrustSeconds) { return $true }
    if (Test-TtsPort) { Set-TtsServerUp; return $true }
    $script:TtsServerOkAt = $null
    $serverScript = $env:DSH_TTS_SERVER_SCRIPT
    if (-not $serverScript -or -not (Test-Path $serverScript)) { return $true }
    if (Test-TtsStartRecentlyFailed) { return $false }
    $waitSeconds = Get-TtsStartWaitSeconds
    $m = New-Object System.Threading.Mutex($false, 'Global\KokoroTtsStart')
    $got = $false
    try {
        try { $got = $m.WaitOne([TimeSpan]::FromSeconds(120)) } catch [System.Threading.AbandonedMutexException] { $got = $true }
        if (-not $got) { return $true }
        if (Test-TtsPort) { Set-TtsServerUp; return $true }
        # Another process may have tried, and failed, while this one waited for the mutex.
        if (Test-TtsStartRecentlyFailed) { return $false }
        Add-TtsLog 'tts-client-errors.log' "server down; starting $serverScript"
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serverScript
        $deadline = (Get-Date).AddSeconds($waitSeconds)
        while ((Get-Date) -lt $deadline -and -not (Test-TtsPort)) { Start-Sleep -Seconds 2 }
        if (Test-TtsPort) { Set-TtsServerUp } else { Set-Content -Path (Get-TtsStartFailedPath) -Value (Get-Date -Format o) -Force }
    } finally {
        if ($got) { $m.ReleaseMutex() }
        $m.Dispose()
    }
    return ($null -ne $script:TtsServerOkAt)
}

# Security: the link regex below is quadratic on hostile input (many '[' without a closing ')'), so the text is capped first.
# Speech lines are short; 4000 characters is far above any real one.
function Clean-ForSpeech([string]$text) {
    if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) }
    $text = $text -replace '\*\*([^*]+)\*\*', '$1'
    $text = $text -replace '\*([^*]+)\*',     '$1'
    $text = $text -replace '`([^`]+)`',       '$1'
    $text = $text -replace '#{1,6}\s*',       ''
    $text = $text -replace '\[([^\]]+)\]\([^)]+\)', '$1'
    $text = $text -replace '[\u2013\u2014]',  ' '
    $text = $text -replace '\s+-\s+',         ' '
    $text = $text -replace '[|~^_]',           ' '
    # \u escapes keep this file pure ASCII (Windows PowerShell 5.1 misreads BOM-less UTF-8).
    $text = $text -replace '[^\x20-\x7E\r\n\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]', '  '
    return $text
}

function Get-WavDurationSeconds([byte[]]$Bytes) {
    $byteRate = $null; $dataSize = $null; $pos = 12
    while ($pos + 8 -le $Bytes.Length) {
        $chunkId = [System.Text.Encoding]::ASCII.GetString($Bytes, $pos, 4)
        $chunkSize = [BitConverter]::ToUInt32($Bytes, $pos + 4)
        if ($chunkId -eq 'fmt ') { $byteRate = [BitConverter]::ToUInt32($Bytes, $pos + 16) }
        elseif ($chunkId -eq 'data') { $dataSize = $chunkSize }
        $pos += 8 + $chunkSize + ($chunkSize % 2)
    }
    if ($byteRate -and $dataSize) { return $dataSize / $byteRate }
    return $null
}

# Deletes a stop flag only when it is older than $Than. A flag created after the call began (a barge-in while the line
# was still being synthesised or queued) must survive so it still cuts that line; older ones are leftovers.
function Remove-StopFlagOlderThan([string]$Path, [datetime]$Than) {
    $item = Get-Item -Path $Path -ErrorAction SilentlyContinue
    if ($item -and $item.LastWriteTime -lt $Than) { Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue }
}

function Invoke-KokoroTts {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][ValidateSet('male', 'female')][string]$Gender,
        [ValidateSet('High', 'Normal')][string]$Priority = 'Normal',
        # Optional pacing, honoured by the Kokoro server: speaking rate (1.0 = normal) and silence between sentences.
        [double]$Speed = 0,
        [double]$PauseSeconds = 0,
        # Optional callback invoked once right before playback starts (the voice flow measures its latency with it);
        # it gets the WAV duration in seconds (or $null when unknown) as its only argument.
        [scriptblock]$OnPlaybackStart = $null,
        # Keep this process out of <hotDir>\audio.pids: a long-lived caller (speak-worker.ps1) must not be killed by the
        # Ctrl+Alt+M hotkey; its playback is cut through the polled tts-stop.flag instead.
        [switch]$NoPidFile,
        # Keep a stop flag created after this call started (a barge-in / Ctrl+Alt+M while the line was synthesised or queued) so it
        # still cuts THIS line. Only speak-worker.ps1 passes it. Legacy hook callers (stop/speak/elicitation) clear every stop flag
        # when they get the playback mutex, so a hotkey press never cuts or eats the NEXT queued alert.
        [switch]$KeepNewerStopFlag,
        # A WAV the caller already has (the plugin's phrase cache): played as is, no server start or request.
        [string]$WavPath = ''
    )
    $callStart = Get-Date
    # Set when the stop flag (Ctrl+Alt+M, barge-in) ended playback early; speak-worker.ps1 reports it as status 'cut'.
    # The function still returns $true for a cut line, so existing callers are unchanged.
    $script:TtsLastCut = $false
    $dir = $script:TtsStateDir
    $flagPath = Join-Path $dir 'tts-priority-pending.flag'
    $stopFlagPath = Join-Path $dir 'tts-stop.flag'
    # Optional: honor the existing Ctrl+Alt+M hotkey (tts-stop-hotkey.exe), which writes
    # <dir>\tts-stop.flag and kills the PIDs listed in <dir>\audio.pids.
    $hotDir = $env:DSH_TTS_HOTKEY_DIR
    # Auto-detect the Claude Code hotkey install so this works without a host restart/config.
    if (-not $hotDir -and (Test-Path (Join-Path $env:USERPROFILE '.claude\tts-stop-hotkey.exe'))) { $hotDir = Join-Path $env:USERPROFILE '.claude' }
    $stopFlags = @($stopFlagPath)
    if ($hotDir -and (Test-Path $hotDir)) { $stopFlags += (Join-Path $hotDir 'tts-stop.flag') }
    $stream = $null; $player = $null; $content = $null; $response = $null
    $mutex = New-Object System.Threading.Mutex($false, 'Global\KokoroTtsPlayback')
    $acquired = $false; $setFlag = $false
    try {
        if ($WavPath -and (Test-Path -LiteralPath $WavPath)) {
            $bytes = [System.IO.File]::ReadAllBytes($WavPath)
        } else {
            # Synthesize immediately; only PLAYBACK is serialized so nothing overlaps audibly.
            $null = Get-TtsHttpClient
            if (-not (Start-TtsServerIfDown)) {
                Add-TtsLog 'tts-client-errors.log' 'server is down and its last start failed; line skipped'
                return $false
            }
            $request = @{ text = $Text; voice_gender = $Gender }
            if ($Speed -gt 0) { $request.speed = $Speed }
            if ($PauseSeconds -gt 0) { $request.pause_s = $PauseSeconds }
            $body = $request | ConvertTo-Json -Compress
            for ($attempt = 1; $attempt -le 2 -and -not $response; $attempt++) {
                try {
                    $content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, 'application/json')
                    $response = (Get-TtsHttpClient).PostAsync($script:TtsUrl, $content).Result
                    $script:TtsHttpWarm = $true
                } catch {
                    $failure = $_
                    # Possibly a connection the server closed while idle: a fresh client gets one more try, but only for a transport
                    # error on a warm client (one that has completed a request, so a pooled connection may exist). A timeout (hung
                    # server) or a failure on a cold client (server down) is not retried. Either way the server is no longer trusted,
                    # and the retry first makes sure it is up.
                    $timedOut = $false; $transport = $false
                    for ($e = $failure.Exception; $e; $e = $e.InnerException) {
                        if ($e -is [System.OperationCanceledException]) { $timedOut = $true }
                        if ($e -is [System.Net.Http.HttpRequestException] -or $e -is [System.IO.IOException]) { $transport = $true }
                    }
                    $retry = $script:TtsHttpWarm -and $attempt -lt 2 -and $transport -and -not $timedOut
                    Remove-TtsHttpClient
                    $script:TtsServerOkAt = $null
                    if ($retry -and -not (Start-TtsServerIfDown)) { $retry = $false }
                    if (-not $retry) { throw $failure }
                } finally {
                    if ($content) { $content.Dispose(); $content = $null }
                }
            }
            if (-not $response.IsSuccessStatusCode) {
                Add-TtsLog 'tts-client-errors.log' "HTTP $([int]$response.StatusCode) from $($script:TtsUrl)"
                return $false
            }
            $bytes = $response.Content.ReadAsByteArrayAsync().Result
        }

        if ($Priority -eq 'High') {
            Set-Content -Path $flagPath -Value (Get-Date -Format o) -Force
            $setFlag = $true
        } else {
            # Yield up to 20s to a pending high-priority speaker; ignore a stale flag.
            $waited = 0
            while ((Test-Path $flagPath) -and $waited -lt 20000) {
                if (((Get-Date) - (Get-Item $flagPath).LastWriteTime).TotalSeconds -gt 20) { break }
                Start-Sleep -Milliseconds 250
                $waited += 250
            }
        }

        try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) }
        catch [System.Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) {
            Add-TtsLog 'tts-client-errors.log' 'mutex timeout after 30s (another speak in progress)'
            return $false
        }

        # Record our PID only now that we hold the playback mutex, so the hotkey kills the speaker that is audible.
        if ($stopFlags.Count -gt 1 -and -not $NoPidFile) { Set-Content -Path (Join-Path $hotDir 'audio.pids') -Value $PID }
        foreach ($f in $stopFlags) {
            if ($KeepNewerStopFlag) { Remove-StopFlagOlderThan $f $callStart }
            else { Remove-Item -Path $f -Force -ErrorAction SilentlyContinue }
        }
        $stream = New-Object System.IO.MemoryStream(, $bytes)
        $player = New-Object System.Media.SoundPlayer
        $player.Stream = $stream
        $player.Load()

        # Async play + poll for the stop flag so cancel/mute halts audio instantly.
        $duration = Get-WavDurationSeconds -Bytes $bytes
        if ($OnPlaybackStart) { $null = & $OnPlaybackStart $duration }
        $player.Play()
        if ($duration) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt ($duration + 0.2)) {
                if ($stopFlags | Where-Object { Test-Path $_ }) {
                    $player.Stop()
                    $script:TtsLastCut = $true
                    foreach ($f in $stopFlags) { Remove-Item -Path $f -Force -ErrorAction SilentlyContinue }
                    break
                }
                Start-Sleep -Milliseconds 50
            }
        } else {
            $player.PlaySync()
        }
        return $true
    } catch {
        Add-TtsLog 'tts-client-errors.log' "$($_.Exception.GetType().FullName): $($_.Exception.Message)"
        return $false
    } finally {
        if ($player) { $player.Dispose() }
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
        if ($setFlag) { Remove-Item -Path $flagPath -Force -ErrorAction SilentlyContinue }
    }
}


# Hook payloads arrive as UTF-8 JSON on stdin; Windows PowerShell 5.1 would otherwise read them in the console code page.
function Read-HookInput {
    $raw = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))).ReadToEnd()
    try { $raw | ConvertFrom-Json } catch { $null }
}

# Spoken location suffix: project (cwd leaf) plus the session name when the host supplies one.
function Get-TtsWhere($data) {
    $parts = @()
    if ($data -and $data.cwd) { $parts += "Project : $(Split-Path $data.cwd -Leaf)" }
    if ($data -and $data.session_title) { $parts += "Session : $($data.session_title)" }
    return ($parts -join ' ; ')
}
