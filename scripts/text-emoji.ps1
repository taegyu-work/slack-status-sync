# Bold Korean text with a "sticker" white outline hugging the glyph shapes —
# a die-cut border, not a padded pill/badge. The earlier pill/ring badge
# failed because it added padding around the text, shrinking it inside a
# fixed-size frame; this instead stamps the SAME text in white at many small
# offsets around a circle of radius $outline (a cheap Minkowski-sum dilate),
# then draws the real colored text on top — the outline only ever costs the
# fit-loop a margin equal to its own width, not a separate shape's padding.
#
# Verify with the "simulate actual size" step before trusting a 128px preview
# — Slack shows status emoji at ~16-20px inline.

Add-Type -AssemblyName System.Drawing

function New-StickerEmoji {
    param(
        [string]$Text,
        [string]$DestPath,
        [int]$OutSize = 128,
        [int]$Super = 4,                 # supersample factor for crisp edges
        [string]$TextHex = "0288D1",     # readable in both Slack themes
        [string]$OutlineHex = "FFFFFF",  # sticker peel border
        [double]$OutlineRatio = 0.07,    # outline thickness as a fraction of OutSize
        [string]$FontFamily = "Malgun Gothic"
    )
    $big = $OutSize * $Super
    $bmp = New-Object System.Drawing.Bitmap($big, $big, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $outline = [int]($big * $OutlineRatio)
    $margin = $outline
    $maxW = $big - 2 * $margin
    $maxH = $big - 2 * $margin

    $textColor = [System.Drawing.ColorTranslator]::FromHtml("#$TextHex")
    $outlineColor = [System.Drawing.ColorTranslator]::FromHtml("#$OutlineHex")

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

    $rect = New-Object System.Drawing.RectangleF(0, 0, $big, $big)

    # Stamp the outline color at many offsets around two concentric circles
    # (radius $outline and 0.6x that) so the union hugs every glyph — thin
    # strokes included — like a dilated mask, not a separate ring shape.
    $outlineBrush = New-Object System.Drawing.SolidBrush($outlineColor)
    foreach ($rMul in @(1.0, 0.6)) {
        $r = $outline * $rMul
        $steps = 24
        for ($i = 0; $i -lt $steps; $i++) {
            $theta = 2 * [Math]::PI * $i / $steps
            $dx = [float]($r * [Math]::Cos($theta))
            $dy = [float]($r * [Math]::Sin($theta))
            $offRect = New-Object System.Drawing.RectangleF($dx, $dy, $big, $big)
            $g.DrawString($Text, $font, $outlineBrush, $offRect, $fmt)
        }
    }

    $brush = New-Object System.Drawing.SolidBrush($textColor)
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
    Write-Output "$DestPath -> $bytes bytes (font ${fontSize}px of ${big}px canvas, outline ${outline}px)"
}

function From-B64 {
    param([string]$B64)
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
}

# --- current set (regenerate with: node -e "console.log(Buffer.from('연차','utf8').toString('base64'))") ---
$outDir = Join-Path $env:USERPROFILE "Desktop"
New-StickerEmoji -Text (From-B64 "7Jew7LCo")     -DestPath (Join-Path $outDir "yeoncha.png")
New-StickerEmoji -Text (From-B64 "67CY7LCo")     -DestPath (Join-Path $outDir "bancha.png")
New-StickerEmoji -Text (From-B64 "67CY67CY7LCo") -DestPath (Join-Path $outDir "banbancha.png")
