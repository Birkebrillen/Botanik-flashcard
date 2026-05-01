# Upload images to Cloudflare R2 + rebuild image_manifest.json
# Kør fra projektroden:
#   .\update-image-manifest.ps1
#
# Kræver:
# - rclone.exe ligger i projektroden (samme mappe som index.html)
# - rclone remote hedder "r2" og bucket hedder "botanik-fotos"

$ErrorActionPreference = "Stop"

# --- SETTINGS ---
$imagesDir = "images"
$outFile = "data\image_manifest.json"
$rcloneExe = ".\rclone.exe"
$rcloneDest = "r2:botanik-fotos"
$exts = @(".jpg",".jpeg",".png",".webp",".gif")

if (-not (Test-Path $imagesDir)) {
  throw "Mappen '$imagesDir' findes ikke. Tjek at du kører fra projektroden."
}
if (-not (Test-Path $rcloneExe)) {
  throw "Fandt ikke $rcloneExe. Læg rclone.exe i projektroden."
}

Write-Host "=== 1) Upload til R2 ==="
& $rcloneExe copy ".\$imagesDir" $rcloneDest --progress
Write-Host "Upload faerdig"

Write-Host "=== 2) Byg image_manifest.json ==="
$index = @{}

Get-ChildItem -Path $imagesDir -File | ForEach-Object {
  $name = $_.Name
  $ext  = $_.Extension.ToLower()

  if ($exts -notcontains $ext) { return }
  if ($name -notmatch "_") { return }

  # artKey = alt før sidste underscore
  $artKey = ($name -replace "_[^_]+$","")
  if ([string]::IsNullOrWhiteSpace($artKey)) { return }

  if (-not $index.ContainsKey($artKey)) {
    $index[$artKey] = New-Object System.Collections.Generic.List[string]
  }
  $index[$artKey].Add($name)
}

# sortér filnavne pr. art
$keys = @($index.Keys)
foreach ($k in $keys) {
  $index[$k] = $index[$k] | Sort-Object
}

New-Item -ItemType Directory -Force -Path (Split-Path $outFile) | Out-Null
$index | ConvertTo-Json -Depth 6 | Out-File -Encoding UTF8 $outFile

Write-Host "Skrev manifest:" $outFile
Write-Host "Antal arter:" $index.Keys.Count