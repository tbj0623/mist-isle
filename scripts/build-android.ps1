$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
    $sdk = $env:ANDROID_HOME
    if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
    if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    if (-not (Test-Path -LiteralPath $sdk)) { throw 'Android SDK not found. Set ANDROID_HOME.' }
    $env:ANDROID_HOME = $sdk
    $gradle = Get-Command gradle.bat -ErrorAction SilentlyContinue
    if ($gradle) { $gradlePath = $gradle.Source }
    else {
        $cached = Join-Path $env:USERPROFILE '.gradle\wrapper\dists'
        $gradlePath = Get-ChildItem -LiteralPath $cached -Filter gradle.bat -Recurse -ErrorAction SilentlyContinue |
            Where-Object FullName -Match 'gradle-8\.14\.3' | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $gradlePath -and (Test-Path -LiteralPath (Join-Path $root 'android\gradlew.bat'))) { $gradlePath = Join-Path $root 'android\gradlew.bat' }
    if (-not $gradlePath) { throw 'Gradle 8.14.3 not found. Install it or run android/gradlew.bat.' }
    & $gradlePath -p (Join-Path $root 'android') assembleDebug --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    $dest = Join-Path $root 'artifacts'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $apkName = "mist-isle-$version-debug.apk"
    Copy-Item -LiteralPath (Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk') -Destination (Join-Path $dest $apkName) -Force
    Write-Output "APK: $dest\$apkName"
} finally { Pop-Location }
