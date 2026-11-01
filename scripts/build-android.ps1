param(
    # debug   : assembleDebug（本机验证，不需要 keystore）
    # release : assembleRelease → APK（必须有正式 keystore，否则 Gradle 直接失败）
    # bundle  : bundleRelease → AAB（Google Play 自 2021 起强制要求）
    # both    : debug + release APK
    # all     : debug + release APK + release AAB
    [ValidateSet('debug', 'release', 'bundle', 'both', 'all')]
    [string]$Variant = 'debug',
    # -Aab 是 -Variant bundle 的简写：单独用 -Aab 即出 AAB；
    # 与 -Variant release/both 同用则追加 AAB（= all）。
    [switch]$Aab,
    # 共享工作区里 client/ 或 shared/ 被别人改到半截时（esbuild 直接失败），
    # 可以显式跳过 Web 构建，复用 android/app/src/main/assets 里已同步的产物。
    # 只验证壳层（MainActivity / 签名 / 混淆）时用它，正式出包不要用。
    [switch]$SkipWebBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# ── 辅助函数（必须在 try 之前定义：PowerShell 的函数体在脚本执行到该行后才注册）──

<#
.SYNOPSIS
  release APK 验签：证书主题含 CN=Android Debug 时抛错，拒绝产出正式包。
.DESCRIPTION
  `apksigner verify --print-certs` 是 Android SDK 自带的权威判定，比读 build.gradle 的
  signingConfig 更可靠 —— 即使将来又有人把回退 debug 签名的逻辑加回去，这里也会拦下。
#>
function Assert-ReleaseSigned {
    param([Parameter(Mandatory = $true)][string]$ApkPath, [Parameter(Mandatory = $true)][string]$Sdk)

    $signer = Join-Path $Sdk 'build-tools'
    $apksigner = Get-ChildItem -LiteralPath $signer -Filter 'apksigner.bat' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $apksigner) { throw "apksigner not found under $signer（请检查 Android SDK build-tools）" }

    # apksigner 找不到 java 时也需要 JAVA_HOME；已配置的环境通常无需干预。
    # 注意：Windows PowerShell 5.1 在 $ErrorActionPreference='Stop' 下把原生命令的
    # stderr 重定向（2>&1）当成 NativeCommandError 直接抛出，这里临时降级再还原。
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $apksigner verify --print-certs $ApkPath 2>&1 } finally { $ErrorActionPreference = $previousEap }
    $signExit = $LASTEXITCODE
    $text = $output -join "`n"
    if ($signExit -ne 0) {
        throw "apksigner verify 失败，release APK 未通过签名校验：`n$text"
    }
    if ($text -match 'CN=Android Debug') {
        throw ("release APK 使用了 debug 证书（CN=Android Debug），已拒绝产出正式包。`n" +
            "  证书信息：`n$text`n" +
            "  请配置正式 keystore（见 android/keystore.properties.example）；" +
            "本机安装验证请用 -Variant debug。")
    }
    # 证书 DN 中文/特殊字符的编码随控制台代码页变化，这里只回显 apksigner 原始行
    $dn = $text -split "`n" | Where-Object { $_ -match 'certificate DN' } | Select-Object -First 1
    Write-Output "签名校验通过：$dn"
}

<#
.SYNOPSIS
  归档 R8 混淆映射（mapping.txt），商店反混淆崩溃栈必需。
#>
function Save-Mapping {
    param([Parameter(Mandatory = $true)][string]$Version, [Parameter(Mandatory = $true)][string]$Dest)

    $mapping = Join-Path $root 'android\app\build\outputs\mapping\release\mapping.txt'
    if (-not (Test-Path -LiteralPath $mapping)) {
        Write-Warning "未找到 R8 mapping.txt（$mapping）：release 产物里的崩溃栈将无法反混淆"
        return
    }
    $target = Join-Path $Dest "mapping-$Version.txt"
    Copy-Item -LiteralPath $mapping -Destination $target -Force
    $sizeKb = [math]::Round((Get-Item -LiteralPath $target).Length / 1KB, 1)
    Write-Output "mapping: $target ($sizeKb KB)"
}

Push-Location $root
try {
    # ── 版本一致性校验（构建前 fail fast）─────────────────────────────────────
    # 版本唯一来源是根目录 package.json；android/app/build.gradle 直接读它（不再有兜底字面量），
    # 这里校验这条单源链路没有被破坏。
    #
    # versionCode 规则（与 android/app/build.gradle 的 versionCodeFor 同步实现）：
    #   major*100 + minor*10 + patch，如 1.0.0 -> 100、1.2.3 -> 123。
    #   约束：minor / patch 必须 < 9+1；越界时这里直接报错而不是悄悄算错 versionCode
    #   （到 1.10.x 需要改成 major*10000+minor*100+patch 并同步旧包升级路径）。
    $version = (& node -p "require('./package.json').version" 2>$null)
    if (-not $version) {
        # 用 node 读版本号：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 读 UTF-8，
        # package.json 里的中文 description 会被读成乱码导致 ConvertFrom-Json 失败；
        # 这里的 -Encoding UTF8 回退只兜 node 不可用的场景。
        $version = ((Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version)
    }
    $version = "$version".Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw "package.json 的 version 必须是 X.Y.Z 数字格式（参与 versionCode 计算），当前为 '$version'"
    }
    $semver = ($version -split '\.') | ForEach-Object { [int]$_ }
    if ($semver[1] -gt 9 -or $semver[2] -gt 9) {
        throw ("版本 {0} 的 minor/patch 超过 9：versionCode 规则是 major*100+minor*10+patch，" +
            "请先调整方案（见 android/app/build.gradle 的 versionCodeFor 注释）再发布") -f $version
    }
    # 版本号已是单源：build.gradle 直接读 package.json，不再有兜底字面量需要比对。
    # 这里只校验「它确实是单源」—— 如果 build.gradle 里又出现了硬编码版本号，
    # 说明有人把第二真源加回来了，构建期就该拦下。
    $gradleText = Get-Content -LiteralPath (Join-Path $root 'android\app\build.gradle') -Raw -Encoding UTF8
    if ($gradleText -notmatch 'pkgVersion\s*=\s*matcher\.group\(1\)') {
        throw 'android/app/build.gradle 没有从 package.json 读取版本号（单源已失效），请检查该文件'
    }
    # 只匹配「行首（可带缩进）的赋值语句」，避免把注释里提到的 pkgVersion 当成硬编码
    if ($gradleText -match "(?m)^\s*def\s+pkgVersion\s*=\s*'[0-9]") {
        throw 'android/app/build.gradle 里出现了硬编码的 pkgVersion 字面量：版本号必须以 package.json 为唯一来源'
    }

    # ── -Aab 归一化：它只是 -Variant bundle 的另一种写法 ───────────────────────
    if ($Aab) {
        switch ($Variant) {
            'debug' { $Variant = 'bundle' }
            'release' { $Variant = 'all' }
            'both' { $Variant = 'all' }
        }
    }
    $wantsDebug = $Variant -in @('debug', 'both', 'all')
    $wantsReleaseApk = $Variant -in @('release', 'both', 'all')
    $wantsBundle = $Variant -in @('bundle', 'all')

    # Web 产物 → dist/ 与 android/app/src/main/assets/（build.mjs 负责两处同步）
    if ($SkipWebBuild) {
        $assetsJs = Join-Path $root 'android\app\src\main\assets\app.js'
        if (-not (Test-Path -LiteralPath $assetsJs)) { throw '-SkipWebBuild 需要已存在的 android/app/src/main/assets/app.js' }
        Write-Warning "跳过 npm run build，复用 $(Get-Item -LiteralPath $assetsJs | Select-Object -ExpandProperty LastWriteTime) 的 assets"
    } else {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) {
            throw 'Web build failed（若只是 client/shared 正在被别人编辑，可加 -SkipWebBuild 复用现有 assets）'
        }
    }

    # 签名前置检查：release/bundle 需要正式 keystore。Gradle 侧 verifyReleaseSigning 也会拦，
    # 这里提前给一条更直白的中文提示（避免让人翻 Gradle 堆栈）。
    if ($wantsReleaseApk -or $wantsBundle) {
        $keystoreProps = Join-Path $root 'android\keystore.properties'
        if (-not (Test-Path -LiteralPath $keystoreProps)) {
            throw ("缺少 android/keystore.properties，拒绝构建 release/bundle —— " +
                "不会再用 debug 签名冒充正式包。本机安装验证请改用 -Variant debug；" +
                "正式出包请按 android/keystore.properties.example 生成 keystore。")
        }
        if ($gradleText -notmatch 'allowDebugRelease') {
            throw 'android/app/build.gradle 缺少 verifyReleaseSigning 签名闸门（release 有回退 debug 签名的风险），请检查该文件'
        }
    }

    $sdk = $env:ANDROID_HOME
    if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
    if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    if (-not (Test-Path -LiteralPath $sdk)) { throw 'Android SDK not found. Set ANDROID_HOME.' }
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk

    $gradle = Get-Command gradle.bat -ErrorAction SilentlyContinue
    if ($gradle) { $gradlePath = $gradle.Source }
    else {
        $cached = Join-Path $env:USERPROFILE '.gradle\wrapper\dists'
        $gradlePath = Get-ChildItem -LiteralPath $cached -Filter gradle.bat -Recurse -ErrorAction SilentlyContinue |
            Where-Object FullName -Match 'gradle-8\.14\.3' | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $gradlePath -and (Test-Path -LiteralPath (Join-Path $root 'android\gradlew.bat'))) { $gradlePath = Join-Path $root 'android\gradlew.bat' }
    if (-not $gradlePath) { throw 'Gradle 8.14.3 not found. Install it or run android/gradlew.bat.' }

    $tasks = @()
    if ($wantsDebug) { $tasks += 'assembleDebug' }
    if ($wantsReleaseApk) { $tasks += 'assembleRelease' }
    if ($wantsBundle) { $tasks += 'bundleRelease' }
    # @tasks 展开：直接传 @() 会被 PowerShell 当成单个参数，Gradle 只会收到 "s" 之类的残片
    $gradleArgs = @('-p', (Join-Path $root 'android')) + $tasks + @('--console=plain')
    & $gradlePath @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Android build failed ($($tasks -join ', '))" }

    $dest = Join-Path $root 'artifacts'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    # ── debug APK ────────────────────────────────────────────────────────────
    if ($wantsDebug) {
        $src = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
        if (-not (Test-Path -LiteralPath $src)) { throw "APK not found: $src" }
        $target = Join-Path $dest "mist-isle-$version-debug.apk"
        Copy-Item -LiteralPath $src -Destination $target -Force
        $sizeMb = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 2)
        Write-Output "APK [debug]: $target ($sizeMb MB)"
    }

    # ── release APK：复制前必须验签，debug 证书一律拒绝 ──────────────────────
    if ($wantsReleaseApk) {
        $src = Join-Path $root 'android\app\build\outputs\apk\release\app-release.apk'
        if (-not (Test-Path -LiteralPath $src)) { throw "APK not found: $src" }
        Assert-ReleaseSigned -ApkPath $src -Sdk $sdk
        $target = Join-Path $dest "mist-isle-$version-release.apk"
        Copy-Item -LiteralPath $src -Destination $target -Force
        $sizeMb = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 2)
        Write-Output "APK [release]: $target ($sizeMb MB)"
        Save-Mapping -Version $version -Dest $dest
    }

    # ── release AAB（Google Play 自 2021 年起只收 AAB）──────────────────────
    if ($wantsBundle) {
        $src = Join-Path $root 'android\app\build\outputs\bundle\release\app-release.aab'
        if (-not (Test-Path -LiteralPath $src)) { throw "AAB not found: $src" }
        $target = Join-Path $dest "mist-isle-$version-release.aab"
        Copy-Item -LiteralPath $src -Destination $target -Force
        $sizeMb = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 2)
        Write-Output "AAB [release]: $target ($sizeMb MB)"
        # AAB 由 Play 重新签名，本地不做 apksigner 校验；但必须确认 Gradle 用的是正式 keystore。
        # verifyReleaseSigning 已在构建期保证这一点（缺 keystore 时 bundleRelease 根本跑不起来）。
        Save-Mapping -Version $version -Dest $dest
    }
} finally { Pop-Location }
