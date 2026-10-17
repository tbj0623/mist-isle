$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$out = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$archive = Join-Path $out "mist-isle-$version-source.zip"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create)
$zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
    $files = @()
    foreach ($name in @('package.json','package-lock.json','README.md','THIRD_PARTY_NOTICES.md','Dockerfile','.dockerignore','.gitignore','playwright.config.mjs')) {
        $files += Get-Item -LiteralPath (Join-Path $root $name)
    }
    foreach ($name in @('client','shared','server','scripts','tests','docs','deploy','android')) {
        $files += Get-ChildItem -LiteralPath (Join-Path $root $name) -File -Recurse -Force | Where-Object {
            $relative = $_.FullName.Substring($root.Length + 1).Replace('\','/')
            $relative -notmatch '(^|/)(build|\.gradle|\.kotlin)/|^android/app/src/main/assets/|local\.properties$|\.log$|\.jks$|\.keystore$'
        }
    }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $count++
    }
} finally { $zip.Dispose(); $stream.Dispose() }
Write-Output "Source archive: $archive ($count files)"
Get-FileHash -LiteralPath $archive -Algorithm SHA256
