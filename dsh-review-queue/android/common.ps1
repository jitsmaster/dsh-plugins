# Shared helpers for the android/*.ps1 scripts (dot-sourced). No secrets are read or printed here.
Set-StrictMode -Version Latest
$script:AndroidDir = $PSScriptRoot
$script:StateDir = Join-Path $env:USERPROFILE '.dsh\review-queue'

function Get-GradleProp([string]$Name) {
    $line = Get-Content (Join-Path $script:AndroidDir 'gradle.properties') | Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '\s*=') } | Select-Object -First 1
    if (-not $line) { throw "gradle.properties has no $Name" }
    return ($line -replace '^[^=]+=\s*', '').Trim()
}

function Get-HubConfigPath([string]$Override) {
    if ($Override) { return $Override }
    return (Join-Path $script:StateDir 'hub.config.json')
}

function Get-HubPort([string]$ConfigPath) {
    if (Test-Path $ConfigPath) {
        try { $p = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).hubPort; if ($p) { return [int]$p } } catch { }
    }
    return 47615
}

# JDK 17: -Jdk, else RQ_JDK17, else android/local-tools.json {"jdk17": "<dir>"}, else the JAVA_HOME already set.
function Resolve-Jdk([string]$Override) {
    $cands = @($Override, $env:RQ_JDK17)
    $tools = Join-Path $script:AndroidDir 'local-tools.json'
    if (Test-Path $tools) { try { $cands += (Get-Content $tools -Raw | ConvertFrom-Json).jdk17 } catch { } }
    $cands += $env:JAVA_HOME
    foreach ($c in $cands) {
        if ($c -and (Test-Path (Join-Path $c 'bin\java.exe'))) { return (Resolve-Path $c).Path }
    }
    throw 'No JDK 17 found. Pass -Jdk <dir>, set RQ_JDK17, or put {"jdk17": "<dir>"} in android/local-tools.json.'
}

function Resolve-Sdk() {
    foreach ($c in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
        if ($c -and (Test-Path (Join-Path $c 'platforms'))) { return (Resolve-Path $c).Path }
    }
    throw 'Android SDK not found. Set ANDROID_HOME or install it under %LOCALAPPDATA%\Android\Sdk.'
}

function Resolve-Adb() {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $p = Join-Path (Resolve-Sdk) 'platform-tools\adb.exe'
    if (Test-Path $p) { return $p }
    throw 'adb not found (install platform-tools in the SDK or put adb on PATH).'
}

function Find-ApkSigner() {
    $bt = Join-Path (Resolve-Sdk) 'build-tools'
    $dir = Get-ChildItem $bt -Directory -ErrorAction SilentlyContinue | Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } -Descending | Where-Object { Test-Path (Join-Path $_.FullName 'apksigner.bat') } | Select-Object -First 1
    if (-not $dir) { throw "apksigner.bat not found under $bt" }
    return (Join-Path $dir.FullName 'apksigner.bat')
}

# Where Gradle leaves the APK for a variant: debug | release | localDebug.
function Get-ApkPath([string]$Variant) {
    return (Join-Path $script:AndroidDir "app\build\outputs\apk\$Variant\app-$Variant.apk")
}

# Reads the untracked keystore.properties into a hashtable (values stay in memory; callers never print them).
function Read-KeystoreProps() {
    $file = Join-Path $script:AndroidDir 'keystore.properties'
    if (-not (Test-Path $file)) { return $null }
    $h = @{}
    foreach ($l in Get-Content $file) { if ($l -match '^\s*([^#=\s]+)\s*=\s*(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() } }
    return $h
}
