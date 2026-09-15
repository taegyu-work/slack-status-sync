# Turns a photo of handwritten text into Slack-ready custom-emoji PNGs:
# crops a square region per word, resizes to 128x128, thresholds to an ink
# mask, dilates it into a white "sticker" outline traced around the letters,
# and renders ink in a dark-ish blue on a transparent background everywhere
# else.
#
# Usage: adjust $srcImg and the Export-Emoji calls at the bottom (crop boxes
# are specific to one source photo's layout/resolution — re-measure them for
# a new photo, e.g. with a gridded debug crop, before reusing this). Crop as
# TIGHT as you can around the ink (minimal padding) — Slack always displays
# emoji at a fixed small size, so anything less than a tight crop just makes
# the handwriting look smaller/fainter for no benefit. A word with more
# syllables (wider) will still look smaller than a shorter word even at the
# tightest possible crop, since both share the same square canvas — the only
# real fix for that is a two-line layout of the source handwriting.
#
# Output stays under Slack's 128KB custom-emoji limit by a wide margin
# (usually 1-2KB) since it's a flat-color mask, not a photo.

Add-Type -AssemblyName System.Drawing

function Export-Emoji {
    param(
        [string]$SourcePath,
        [string]$DestPath,
        [int]$CropX, [int]$CropY, [int]$CropW, [int]$CropH,
        [int]$OutSize = 128,
        [int]$Threshold = 90,
        [int]$HaloRadius = 5
    )
    $srcBmp = New-Object System.Drawing.Bitmap($SourcePath)
    $cropRect = New-Object System.Drawing.Rectangle($CropX, $CropY, $CropW, $CropH)
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $OutSize, $OutSize)

    $resized = New-Object System.Drawing.Bitmap($OutSize, $OutSize)
    $gfx = [System.Drawing.Graphics]::FromImage($resized)
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.DrawImage($srcBmp, $destRect, $cropRect, [System.Drawing.GraphicsUnit]::Pixel)
    $gfx.Dispose()
    $srcBmp.Dispose()

    # 1. Threshold -> ink mask
    $ink = New-Object 'bool[,]' $OutSize, $OutSize
    for ($yy = 0; $yy -lt $OutSize; $yy++) {
        for ($xx = 0; $xx -lt $OutSize; $xx++) {
            $px = $resized.GetPixel($xx, $yy)
            $lum = (0.299 * $px.R) + (0.587 * $px.G) + (0.114 * $px.B)
            $ink[$xx, $yy] = ($lum -lt $Threshold)
        }
    }
    $resized.Dispose()

    # 2. Circular neighbor offsets for the halo radius
    $offsets = @()
    for ($dy = -$HaloRadius; $dy -le $HaloRadius; $dy++) {
        for ($dx = -$HaloRadius; $dx -le $HaloRadius; $dx++) {
            if (($dx * $dx + $dy * $dy) -le ($HaloRadius * $HaloRadius)) {
                $offsets += , @($dx, $dy)
            }
        }
    }

    # 3. Dilate ink -> halo (a "sticker" outline tracing the letters)
    $halo = New-Object 'bool[,]' $OutSize, $OutSize
    for ($yy = 0; $yy -lt $OutSize; $yy++) {
        for ($xx = 0; $xx -lt $OutSize; $xx++) {
            if ($ink[$xx, $yy]) { continue }
            foreach ($o in $offsets) {
                $nx = $xx + $o[0]
                $ny = $yy + $o[1]
                if ($nx -ge 0 -and $nx -lt $OutSize -and $ny -ge 0 -and $ny -lt $OutSize -and $ink[$nx, $ny]) {
                    $halo[$xx, $yy] = $true
                    break
                }
            }
        }
    }

    # 4. Render: ink = dark-ish blue, halo = white outline, else transparent
    $final = New-Object System.Drawing.Bitmap($OutSize, $OutSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $inkColor = [System.Drawing.Color]::FromArgb(255, 2, 136, 209)  # #0288D1
    $haloColor = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    $clear = [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
    for ($yy = 0; $yy -lt $OutSize; $yy++) {
        for ($xx = 0; $xx -lt $OutSize; $xx++) {
            if ($ink[$xx, $yy]) {
                $final.SetPixel($xx, $yy, $inkColor)
            } elseif ($halo[$xx, $yy]) {
                $final.SetPixel($xx, $yy, $haloColor)
            } else {
                $final.SetPixel($xx, $yy, $clear)
            }
        }
    }
    $final.Save($DestPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $final.Dispose()

    $bytes = (Get-Item $DestPath).Length
    Write-Output "$DestPath -> $bytes bytes"
}

# --- Example (the final 2026-09-15 연차/반차/반반차 batch, tight crops) ---
# $srcImg = "$env:USERPROFILE\Desktop\20260915_131829.jpg"
# $outDir = "$env:USERPROFILE\Desktop"
# Export-Emoji -SourcePath $srcImg -DestPath (Join-Path $outDir "yeoncha.png")   -CropX 1022 -CropY 430  -CropW 860 -CropH 860
# Export-Emoji -SourcePath $srcImg -DestPath (Join-Path $outDir "bancha.png")    -CropX 1098 -CropY 1782 -CropW 706 -CropH 706
# Export-Emoji -SourcePath $srcImg -DestPath (Join-Path $outDir "banbancha.png") -CropX 1102 -CropY 2621 -CropW 960 -CropH 960
