<#
.SYNOPSIS
  One-time: creates the release signing key outside the repo (%USERPROFILE%\.dsh\review-queue\android-signing\rq-release.jks) and writes the
  untracked android/keystore.properties. The password is typed here (hidden), kept only in the key file and keystore.properties, never printed.
  An existing key file is never overwritten: losing the key means the phone must uninstall and reinstall the app.
#>
[CmdletBinding()]
param(
    [string]$KeyFile = (Join-Path $env:USERPROFILE '.dsh\review-queue\android-signing\rq-release.jks'),
    [string]$Alias = 'rq',
    [string]$Jdk,
    [string]$DistinguishedName = 'CN=DSH Review Queue'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$keytool = Join-Path (Resolve-Jdk $Jdk) 'bin\keytool.exe'
$props = Join-Path $PSScriptRoot 'keystore.properties'
if (Test-Path $KeyFile) { throw "$KeyFile already exists; not overwritten." }
if (Test-Path $props) { throw "$props already exists; not overwritten." }

$secure = Read-Host 'Choose a key password (at least 6 characters; hidden)' -AsSecureString
$secret = [System.Net.NetworkCredential]::new('', $secure).Password
if ($secret.Length -lt 6) { throw 'The password must be at least 6 characters.' }

New-Item -ItemType Directory -Force (Split-Path $KeyFile) | Out-Null
$env:RQ_KEYTOOL_PASS = $secret
try {
    & $keytool -genkeypair -keystore $KeyFile -alias $Alias -keyalg RSA -keysize 2048 -validity 10000 -dname $DistinguishedName -storepass:env RQ_KEYTOOL_PASS -keypass:env RQ_KEYTOOL_PASS
    if ($LASTEXITCODE -ne 0) { throw 'keytool -genkeypair failed' }
} finally { Remove-Item Env:RQ_KEYTOOL_PASS -ErrorAction SilentlyContinue }

$lines = @(
    'storeFile=' + ($KeyFile -replace '\\', '/'),
    'storePassword=' + $secret,
    'keyAlias=' + $Alias,
    'keyPassword=' + $secret
)
Set-Content -Path $props -Value $lines -Encoding ascii
Write-Host "Key file: $KeyFile"
Write-Host "Wrote $props (untracked). Back the key file up: it cannot be recreated."
Write-Host 'Next: ./fingerprint.ps1, then ./build.ps1 -Release.'
