<#
.SYNOPSIS
  Prints the SHA-256 fingerprints of the release and debug signing certificates and writes them, with the package name, into
  hub.config.json (android.sha256CertFingerprints) so the hub serves them in /.well-known/assetlinks.json. Restart the hub afterwards.
.EXAMPLE
  ./fingerprint.ps1            # release + debug, written to hub.config.json
  ./fingerprint.ps1 -NoWrite   # print only
#>
[CmdletBinding()]
param(
    [string]$HubConfig,
    [string]$Jdk,
    [switch]$NoWrite
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$keytool = Join-Path (Resolve-Jdk $Jdk) 'bin\keytool.exe'

# keytool reads the password from an environment variable, so it never shows on a command line; the value is never printed.
function Get-CertSha256([string]$StoreFile, [string]$Alias, [string]$Secret) {
    $env:RQ_KEYTOOL_PASS = $Secret
    try {
        $out = & $keytool -list -v -keystore $StoreFile -alias $Alias -storepass:env RQ_KEYTOOL_PASS 2>&1 | Out-String
    } finally { Remove-Item Env:RQ_KEYTOOL_PASS -ErrorAction SilentlyContinue }
    if ($out -notmatch 'SHA256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})') { throw "No SHA-256 fingerprint for alias $Alias in $StoreFile (wrong alias or password?)" }
    return $Matches[1].ToUpper()
}

$found = [ordered]@{}
$ks = Read-KeystoreProps
if ($ks -and $ks['storeFile'] -and (Test-Path $ks['storeFile'])) {
    $found['release'] = Get-CertSha256 $ks['storeFile'] $ks['keyAlias'] $ks['storePassword']
} else {
    Write-Warning 'No keystore.properties (or its key file is missing): release fingerprint skipped. Run ./make-release-key.ps1.'
}
$debugStore = Join-Path $env:USERPROFILE '.android\debug.keystore'
if (Test-Path $debugStore) {
    # The Android debug key's well-known public default; it protects nothing.
    $found['debug'] = Get-CertSha256 $debugStore 'androiddebugkey' 'android'
} else {
    Write-Warning "No debug keystore at $debugStore (Gradle creates it on the first debug build)."
}
if ($found.Count -eq 0) { throw 'No fingerprints found.' }
foreach ($k in $found.Keys) { Write-Host ("{0,-8} {1}" -f $k, $found[$k]) }

if (-not $NoWrite) {
    $cfg = Get-HubConfigPath $HubConfig
    $nodeArgs = @((Join-Path $PSScriptRoot 'tools\update-hub-config.mjs'), '--config', $cfg, '--package', (Get-GradleProp 'rq.applicationId'))
    foreach ($v in $found.Values) { $nodeArgs += @('--fingerprint', $v) }
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw 'update-hub-config.mjs failed' }
    Write-Host 'Restart the hub (POST /hub/v1/shutdown) so /.well-known/assetlinks.json picks the change up.'
}
