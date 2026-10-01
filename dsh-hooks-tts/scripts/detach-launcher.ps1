param([Parameter(Mandatory)][string]$ScriptPath)

# Reads the hook payload from stdin, hands it to a hidden detached PowerShell
# running $ScriptPath, and returns immediately so the harness is never blocked.
$raw = [Console]::In.ReadToEnd()
$tmp = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmp, $raw, (New-Object System.Text.UTF8Encoding($false)))
$tmpOut = [System.IO.Path]::GetTempFileName()
$tmpErr = [System.IO.Path]::GetTempFileName()

Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath
) -RedirectStandardInput $tmp -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
