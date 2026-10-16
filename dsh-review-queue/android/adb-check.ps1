<#
.SYNOPSIS
  Read-only report on the device: which APK is installed, how the last launch went (Trusted Web Activity or Custom Tab fallback),
  whether an address bar is on screen, and the notifications the app owns. Parsing is done by tools/adb-report.mjs.
.EXAMPLE
  ./adb-check.ps1 -Serial emulator-5554
  ./adb-check.ps1 -Variant localDebug
#>
[CmdletBinding()]
param(
    [string]$Serial,
    [ValidateSet('main', 'localDebug')][string]$Variant = 'main'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$adb = Resolve-Adb
$pkg = Get-GradleProp 'rq.applicationId'
if ($Variant -eq 'localDebug') { $pkg += '.local' }

$devices = (& $adb devices | Out-String)
$target = @()
if ($Serial) { $target = @('-s', $Serial) }
$ui = ''
$tmp = Join-Path $env:TEMP ('rq-ui-' + [guid]::NewGuid().ToString('N') + '.xml')
try {
    & $adb @target shell uiautomator dump /sdcard/rq-ui.xml 2>&1 | Out-Null
    & $adb @target pull /sdcard/rq-ui.xml $tmp 2>&1 | Out-Null
    if (Test-Path $tmp) { $ui = Get-Content $tmp -Raw }
} finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    & $adb @target shell rm -f /sdcard/rq-ui.xml 2>&1 | Out-Null
}
$payload = [ordered]@{
    packageName = $pkg
    serial      = $Serial
    devices     = $devices
    package     = (& $adb @target shell dumpsys package $pkg | Out-String)
    logcat      = (& $adb @target logcat -d -s TwaLauncher TWALauncherActivity | Out-String)
    notifications = (& $adb @target shell dumpsys notification --noredact | Out-String)
    ui          = $ui
}
$payload | ConvertTo-Json -Depth 3 | & node (Join-Path $PSScriptRoot 'tools\adb-report.mjs')
exit $LASTEXITCODE
