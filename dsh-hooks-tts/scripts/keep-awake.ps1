# Keeps Windows awake while the DSH server process (-ParentPid) runs: a persistent SetThreadExecutionState request
# (ES_CONTINUOUS | ES_SYSTEM_REQUIRED, plus ES_DISPLAY_REQUIRED with -DisplayOn). The request lives with the calling
# thread, so this tiny hidden process holds it; the plugin (keep-awake.js) starts and kills it. It needs no admin rights.
# It exits by itself when the parent is gone (a crashed or killed DSH never leaves the computer awake forever),
# within 30 s, and clears its request on the way out.
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [switch]$DisplayOn
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshKeepAwakeNative {
  public const uint ES_CONTINUOUS = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED = 0x00000001;
  public const uint ES_DISPLAY_REQUIRED = 0x00000002;
  [DllImport("kernel32.dll")] private static extern uint SetThreadExecutionState(uint esFlags);
  public static uint Hold(bool display) {
    uint flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
    if (display) flags |= ES_DISPLAY_REQUIRED;
    return SetThreadExecutionState(flags);
  }
  public static uint Release() { return SetThreadExecutionState(ES_CONTINUOUS); }
}
'@

# Remember the parent's start time so a recycled pid is not mistaken for the parent.
$parentStart = $null
try { $parentStart = [System.Diagnostics.Process]::GetProcessById($ParentPid).StartTime } catch { exit 0 }

function Test-ParentAlive {
  try {
    $p = [System.Diagnostics.Process]::GetProcessById($ParentPid)
    return (-not $p.HasExited) -and ($p.StartTime -eq $parentStart)
  } catch { return $false }
}

try {
  while (Test-ParentAlive) {
    [void][DshKeepAwakeNative]::Hold([bool]$DisplayOn)
    Start-Sleep -Seconds 30
  }
} finally {
  [void][DshKeepAwakeNative]::Release()
}
