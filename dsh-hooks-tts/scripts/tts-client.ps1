$script:TtsStateDir = if ($env:DSH_TTS_STATE_DIR) { $env:DSH_TTS_STATE_DIR } else { Join-Path $env:TEMP 'dsh-tts' }
$script:TtsUrl = if ($env:DSH_TTS_URL) { $env:DSH_TTS_URL } else { 'http://127.0.0.1:8880/tts' }
New-Item -ItemType Directory -Force -Path $script:TtsStateDir | Out-Null

function Test-TtsMuted { Test-Path (Join-Path $script:TtsStateDir 'tts-muted.flag') }

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
function Start-TtsServerIfDown {
    Start-TtsHotkeyIfDown
    if (Test-TtsPort) { return }
    $script = $env:DSH_TTS_SERVER_SCRIPT
    if (-not $script -or -not (Test-Path $script)) { return }
    $m = New-Object System.Threading.Mutex($false, 'Global\KokoroTtsStart')
    $got = $false
    try {
        try { $got = $m.WaitOne([TimeSpan]::FromSeconds(120)) } catch [System.Threading.AbandonedMutexException] { $got = $true }
        if (-not $got -or (Test-TtsPort)) { return }
        Add-TtsLog 'tts-client-errors.log' "server down; starting $script"
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and -not (Test-TtsPort)) { Start-Sleep -Seconds 2 }
    } finally {
        if ($got) { $m.ReleaseMutex() }
        $m.Dispose()
    }
}

function Clean-ForSpeech([string]$text) {
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

function Invoke-KokoroTts {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][ValidateSet('male', 'female')][string]$Gender,
        [ValidateSet('High', 'Normal')][string]$Priority = 'Normal'
    )
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
    $client = $null; $stream = $null
    $mutex = New-Object System.Threading.Mutex($false, 'Global\KokoroTtsPlayback')
    $acquired = $false; $setFlag = $false
    try {
        # Synthesize immediately; only PLAYBACK is serialized so nothing overlaps audibly.
        Add-Type -AssemblyName System.Net.Http
        Start-TtsServerIfDown
        $body = @{ text = $Text; voice_gender = $Gender } | ConvertTo-Json -Compress
        $content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, 'application/json')
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromSeconds(30)
        $response = $client.PostAsync($script:TtsUrl, $content).Result
        if (-not $response.IsSuccessStatusCode) {
            Add-TtsLog 'tts-client-errors.log' "HTTP $([int]$response.StatusCode) from $($script:TtsUrl)"
            return $false
        }
        $bytes = $response.Content.ReadAsByteArrayAsync().Result

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
        if ($stopFlags.Count -gt 1) { Set-Content -Path (Join-Path $hotDir 'audio.pids') -Value $PID }
        foreach ($f in $stopFlags) { Remove-Item -Path $f -Force -ErrorAction SilentlyContinue }
        $stream = New-Object System.IO.MemoryStream(, $bytes)
        $player = New-Object System.Media.SoundPlayer
        $player.Stream = $stream
        $player.Load()

        # Async play + poll for the stop flag so cancel/mute halts audio instantly.
        $duration = Get-WavDurationSeconds -Bytes $bytes
        $player.Play()
        if ($duration) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt ($duration + 0.2)) {
                if ($stopFlags | Where-Object { Test-Path $_ }) {
                    $player.Stop()
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
        if ($stream) { $stream.Dispose() }
        if ($client) { $client.Dispose() }
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
        if ($setFlag) { Remove-Item -Path $flagPath -Force -ErrorAction SilentlyContinue }
    }
}


# Spoken location suffix: project (cwd leaf) plus the session name when the host supplies one.
function Get-TtsWhere($data) {
    $parts = @()
    if ($data -and $data.cwd) { $parts += "Project : $(Split-Path $data.cwd -Leaf)" }
    if ($data -and $data.session_title) { $parts += "Session : $($data.session_title)" }
    return ($parts -join ' ; ')
}
