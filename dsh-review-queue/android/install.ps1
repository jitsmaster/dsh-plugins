<#
.SYNOPSIS
  Installs a built APK on the connected phone or emulator with adb (adb install -r) and optionally starts it.
.EXAMPLE
  ./install.ps1 -Variant release -Launch
  ./install.ps1 -Variant localDebug -Serial emulator-5554 -Launch   # also runs: adb reverse tcp:<hubPort> tcp:<hubPort>
#>
[CmdletBinding()]
param(
    [ValidateSet('debug', 'release', 'localDebug')][string]$Variant = 'release',
    [string]$Apk,
    [string]$Serial,
    [string]$HubConfig,
    [switch]$Launch
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $Apk) { $Apk = Get-ApkPath $Variant }
if (-not (Test-Path $Apk)) { throw "APK not found: $Apk (run ./build.ps1 first)" }
$adb = Resolve-Adb
$pkg = Get-GradleProp 'rq.applicationId'
if ($Variant -eq 'localDebug') { $pkg += '.local' }

if (-not $Serial) {
    $online = @(& $adb devices | ForEach-Object { if ($_ -match '^(\S+)\s+device$') { $Matches[1] } })
    if ($online.Count -eq 0) { throw 'No device online (start the emulator, or connect the phone with USB debugging and accept the prompt).' }
    if ($online.Count -gt 1) { throw ('Several devices online (' + ($online -join ', ') + '): pass -Serial.') }
    $Serial = $online[0]
}

& $adb -s $Serial install -r $Apk
if ($LASTEXITCODE -ne 0) { throw 'adb install failed' }

if ($Variant -eq 'localDebug') {
    # The loopback build reaches the hub on this PC through adb reverse; the https builds go over the tailnet instead.
    $port = Get-HubPort (Get-HubConfigPath $HubConfig)
    & $adb -s $Serial reverse "tcp:$port" "tcp:$port"
    if ($LASTEXITCODE -ne 0) { throw 'adb reverse failed' }
}
if ($Launch) {
    & $adb -s $Serial shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 | Out-Null
}
Write-Host "Installed $pkg on $Serial"
