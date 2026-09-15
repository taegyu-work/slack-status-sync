# Renders a Korean word as a bold, full-bleed Slack custom emoji — no ring,
# no handwriting, no padding to speak of. Slack shows custom status emoji at
# roughly 16-20px inline, and at that size anything that isn't "big bold
# glyphs filling the whole square" turns to mush:
#   - handwritten text (cursive strokes) was illegible even before shrinking
#   - a pill/ring outline around the text (badge style) ate enough of the
#     128x128 canvas that the text inside was too small once shrunk to ~20px
# Plain bold text filling essentially the whole canvas (margin is ~1px at
# 4x supersample, i.e. near-zero), auto-shrunk only as much as needed to fit,
# is what actually reads at real size. Verify with the "simulate actual size"
# snippet at the bottom before trusting a preview at full 128px.
#
# Output is a few KB (flat color, no photo noise) — nowhere near Slack's
# 128KB custom-emoji limit.

Add-Type -AssemblyName System.Drawing

function New-TextEmoji {
    param(
        [string]$Text,
        [string]$DestPath,
        [int]$OutSize = 128,
        [int]$Super = 4,               # supersample factor for crisp edges
        [string]$TextHex = "0288D1",   # readable in both Slack themes
        [string]$FontFamily = "Malgun Gothic"
    )
    $big = $OutSize * $Super
    $bmp = New-Object System.Drawing.Bitmap($big, $big, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $margin = [int](1 * $Super)   # near-zero — fill every pixel we can
    $maxW = $big - 2 * $margin
    $maxH = $big - 2 * $margin

    $textColor = [System.Drawing.ColorTranslator]::FromHtml("#$TextHex")

    # GenericTypographic drops the extra side/line padding StringFormat's
    # default layout reserves, so MeasureString reports the glyphs' real
    # bounding box — the fit loop below can then land on a bigger font size.
    $fmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

    $fontSize = [double]($big * 1.15)   # start oversized; loop shrinks to fit
    $sz = $null
    while ($fontSize -gt 4) {
        $font = New-Object System.Drawing.Font($FontFamily, $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $layout = New-Object System.Drawing.SizeF(($big * 2), ($big * 2))
        $sz = $g.MeasureString($Text, $font, $layout, $fmt)
        if ($sz.Width -le $maxW -and $sz.Height -le $maxH) { break }
        $font.Dispose()
        $fontSize -= 1
    }

    $brush = New-Object System.Drawing.SolidBrush($textColor)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $big, $big)
    $g.DrawString($Text, $font, $brush, $rect, $fmt)

    $g.Dispose()

    $final = New-Object System.Drawing.Bitmap($OutSize, $OutSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g2 = [System.Drawing.Graphics]::FromImage($final)
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $OutSize, $OutSize)
    $g2.Dispose()
    $bmp.Dispose()

    $final.Save($DestPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $final.Dispose()
    $bytes = (Get-Item $DestPath).Length
    Write-Output "$DestPath -> $bytes bytes (font ${fontSize}px of ${big}px canvas)"
}

# Windows PowerShell 5.1 mangles literal Korean characters in a .ps1 file
# saved as UTF-8 without a BOM, so the text to render is passed as base64
# (UTF-8 bytes) instead of embedding it directly in the script.
function From-B64 {
    param([string]$B64)
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
}

# --- current set (regenerate with: node -e "console.log(Buffer.from('연차','utf8').toString('base64'))") ---
$outDir = Join-Path $env:USERPROFILE "Desktop"
New-TextEmoji -Text (From-B64 "7Jew7LCo")     -DestPath (Join-Path $outDir "yeoncha.png")
New-TextEmoji -Text (From-B64 "67CY7LCo")     -DestPath (Join-Path $outDir "bancha.png")
New-TextEmoji -Text (From-B64 "67CY67CY7LCo") -DestPath (Join-Path $outDir "banbancha.png")
