<#
.SYNOPSIS
  Builds the Review Queue TWA APK: debug (default), -Release (signed with keystore.properties) or -LocalDebug (loopback URL for the emulator).
.EXAMPLE
  ./build.ps1                 # app-debug.apk, start URL from hub.config.json publicUrl
  ./build.ps1 -Release        # app-release.apk, verified with apksigner
  ./build.ps1 -LocalDebug     # app-localDebug.apk, http://127.0.0.1:<hubPort>/review-queue/m/ (use adb reverse)
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$LocalDebug,
    [string]$HubConfig,
    [string]$StartUrl,
    [string]$Jdk
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if ($Release -and $LocalDebug) { throw 'Pick one of -Release and -LocalDebug.' }
$variant = if ($Release) { 'release' } elseif ($LocalDebug) { 'localDebug' } else { 'debug' }

$env:JAVA_HOME = Resolve-Jdk $Jdk
$sdk = Resolve-Sdk

# sdk.dir for Gradle (untracked local.properties); an existing file is left alone.
$localProps = Join-Path $PSScriptRoot 'local.properties'
if (-not (Test-Path $localProps)) {
    Set-Content -Path $localProps -Value ('sdk.dir=' + ($sdk -replace '\\', '/')) -Encoding ascii
}

if ($Release) {
    $ks = Read-KeystoreProps
    if (-not $ks -or -not $ks['storeFile'] -or -not (Test-Path $ks['storeFile'])) {
        throw 'Release needs keystore.properties pointing at an existing key file. Run ./make-release-key.ps1 first.'
    }
}

# Resources generated from hub.config.json (start URL, asset statements, launcher art).
$genArgs = @((Join-Path $PSScriptRoot 'tools\gen-resources.mjs'), '--hub-config', (Get-HubConfigPath $HubConfig))
if ($StartUrl) { $genArgs += @('--start-url', $StartUrl) }
& node @genArgs
if ($LASTEXITCODE -ne 0) { throw 'gen-resources.mjs failed' }

$task = 'assemble' + $variant.Substring(0, 1).ToUpper() + $variant.Substring(1)
Push-Location $PSScriptRoot
try {
    & (Join-Path $PSScriptRoot 'gradlew.bat') $task
    if ($LASTEXITCODE -ne 0) { throw "gradlew $task failed" }
} finally { Pop-Location }

$apk = Get-ApkPath $variant
if (-not (Test-Path $apk)) { throw "Expected APK not found: $apk" }
$verify = & (Find-ApkSigner) verify --print-certs $apk 2>&1
if ($LASTEXITCODE -ne 0) { throw ('apksigner verify failed: ' + ($verify -join ' ')) }
Write-Host "APK: $apk"
$verify | Where-Object { $_ -match 'certificate SHA-256 digest' } | ForEach-Object { Write-Host $_ }
