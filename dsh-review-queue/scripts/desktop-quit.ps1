# Finds the DSH desktop app (Electron main process) above -StartPid and, in kill mode, stops it and everything below it.
# The desktop process is the top-most ancestor of -StartPid that has the same image name; it must be an Electron or DeepSeek Harness
# executable and not a child-type process (no --type= on its command line). Modes: find (exit 0 when there is one, 3 when not), plan (print
# the pids that kill would stop, desktop first), kill (stop them, the desktop first, never this script). Exit codes: 0 done, 3 no desktop, 4 failed.
# Kept pure ASCII: Windows PowerShell 5.1 misreads BOM-less UTF-8 source.
param(
    [Parameter(Mandatory)][int]$StartPid,
    [ValidateSet('find', 'plan', 'kill')][string]$Mode = 'find'
)
$ErrorActionPreference = 'Stop'
try {
    $all = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $start = $byId[$StartPid]
    if (-not $start) { exit 3 }
    $top = $start
    for ($i = 0; $i -lt 16; $i++) {
        $parent = $byId[[int]$top.ParentProcessId]
        if ($parent -and $parent.Name -eq $start.Name -and [int]$parent.ProcessId -ne [int]$top.ProcessId) { $top = $parent } else { break }
    }
    if ($top.Name -notmatch '^(?i)(electron|DeepSeek Harness|dsh)[^\\/]*\.exe$') { exit 3 }
    if (([string]$top.CommandLine) -match '--type=') { exit 3 }
    if ($Mode -eq 'find') { Write-Output ([int]$top.ProcessId); exit 0 }

    # The tree below the desktop process, breadth first, from one snapshot (so the stopping does not change what is stopped).
    $children = @{}
    foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $children.ContainsKey($k)) { $children[$k] = @() }; $children[$k] += [int]$p.ProcessId }
    $order = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue([int]$top.ProcessId)
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($order.Contains($id)) { continue }
        $order.Add($id)
        if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { $queue.Enqueue($c) } }
    }
    $targets = @($order | Where-Object { $_ -ne $PID })
    if ($Mode -eq 'plan') { $targets | ForEach-Object { Write-Output $_ }; exit 0 }
    foreach ($id in $targets) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 4
}
