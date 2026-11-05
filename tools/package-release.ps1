param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$ext = Join-Path $root "extension"
$release = Join-Path $root "release"
$manifest = Get-Content (Join-Path $ext "manifest.json") -Raw | ConvertFrom-Json

if (-not $Version) { $Version = $manifest.version }
if ($Version -ne $manifest.version) {
  throw "Version mismatch: requested $Version, manifest is $($manifest.version)"
}

$stage = Join-Path $release ".stage"
$zip = Join-Path $release "local-bilingual-subtitles-v$Version.zip"
$hashFile = "$zip.sha256.txt"
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd("\") + "\"
$stageFull = [IO.Path]::GetFullPath($stage)
if (-not $stageFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to operate outside repository: $stageFull"
}

if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -Path (Join-Path $ext "*") -Destination $stage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "安装说明.txt") -Destination (Join-Path $stage "安装说明.txt") -Force
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
if (Test-Path $hashFile) { Remove-Item -LiteralPath $hashFile -Force }

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

$hash = Get-FileHash -LiteralPath $zip -Algorithm SHA256
$line = "$($hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($zip))"
[IO.File]::WriteAllText($hashFile, $line + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Created: $zip"
Write-Host "SHA256:  $($hash.Hash.ToLowerInvariant())"