# Generates dashboard/og.jpg — the 1200x630 social-share card.
# Uses .NET System.Drawing (Windows). Run: pwsh scripts/gen_og.ps1
Add-Type -AssemblyName System.Drawing

$outPath = Join-Path $PSScriptRoot ".." | Join-Path -ChildPath "dashboard\og.jpg"
$outPath = [System.IO.Path]::GetFullPath($outPath)

$W = 1200; $H = 630
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Background
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(7, 11, 17))
$g.FillRectangle($bg, 0, 0, $W, $H)

# Aurora glows using PathGradientBrush (radial-ish)
function Draw-Glow([int]$cx, [int]$cy, [int]$rad, [int]$cr, [int]$cg, [int]$cb, [int]$alpha) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($cx - $rad, $cy - $rad, $rad * 2, $rad * 2)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = [System.Drawing.Color]::FromArgb($alpha, $cr, $cg, $cb)
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $cr, $cg, $cb))
  $global:g.FillEllipse($brush, $cx - $rad, $cy - $rad, $rad * 2, $rad * 2)
  $brush.Dispose(); $path.Dispose()
}
$global:g = $g
Draw-Glow  130  -30  440   29 111 208 150
Draw-Glow 1150   20  420   27 191 156 120
Draw-Glow  850  760  500   33  64 122 100

# Subtle grid at top (light horizontal + vertical lines with soft top-fade)
$gridPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(10, 255, 255, 255)), 1
for ($x = 0; $x -le $W; $x += 54) { $g.DrawLine($gridPen, $x, 0, $x, 260) }
for ($y = 0; $y -le 260; $y += 54) { $g.DrawLine($gridPen, 0, $y, $W, $y) }
$gridPen.Dispose()

# ---- Brand row (top) ----
# Dot: blue -> teal gradient circle
$dotR = 9
$dotRect = New-Object System.Drawing.RectangleF (65 - $dotR), (68 - $dotR), ($dotR * 2), ($dotR * 2)
$dotBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $dotRect, ([System.Drawing.Color]::FromArgb(70,166,255)), ([System.Drawing.Color]::FromArgb(45,212,191)), 45
$g.FillEllipse($dotBrush, $dotRect)
$dotBrush.Dispose()

$brandFont  = New-Object System.Drawing.Font ("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brandFont2 = New-Object System.Drawing.Font ("Segoe UI", 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$inkBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238,243,250))
$mutBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(159,176,195))
$g.DrawString("SaveOur.Homes", $brandFont, $inkBrush, 82, 55)
$brandW = $g.MeasureString("SaveOur.Homes", $brandFont).Width
$g.DrawString("  · South Miami-Dade", $brandFont2, $mutBrush, (82 + $brandW - 6), 55)

# ---- Eyebrow pill: "Florida Amendment 3 · November 2026" ----
$eyeFont = New-Object System.Drawing.Font ("Segoe UI", 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$eyeText = "Florida Amendment 3 · November 2026"
$eyeSz = $g.MeasureString($eyeText, $eyeFont)
$eyeX = 65; $eyeY = 108; $eyePadX = 18; $eyePadY = 10
$eyeW = [int]($eyeSz.Width + $eyePadX * 2)
$eyeH = [int]($eyeSz.Height + $eyePadY * 2)
$pill = New-Object System.Drawing.Drawing2D.GraphicsPath
$rr = $eyeH / 2
$pill.AddArc($eyeX,               $eyeY,               $rr * 2, $rr * 2, 90, 180)
$pill.AddArc($eyeX + $eyeW - $rr * 2, $eyeY,           $rr * 2, $rr * 2, 270, 180)
$pill.CloseAllFigures()
$pillFill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(25, 45, 212, 191))
$pillStroke = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 45, 212, 191)), 1.5
$g.FillPath($pillFill, $pill); $g.DrawPath($pillStroke, $pill)
$eyeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(189, 238, 222))
$g.DrawString($eyeText, $eyeFont, $eyeBrush, $eyeX + $eyePadX, $eyeY + $eyePadY - 1)
$pill.Dispose(); $pillFill.Dispose(); $pillStroke.Dispose(); $eyeBrush.Dispose()

# ---- Headline (gradient text) ----
$hFont = New-Object System.Drawing.Font ("Segoe UI", 78, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$hRect = New-Object System.Drawing.RectangleF 65, 190, 1000, 220
$hBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $hRect, ([System.Drawing.Color]::FromArgb(255,255,255)), ([System.Drawing.Color]::FromArgb(185,243,223)), 10
$g.DrawString("See how it", $hFont, $hBrush, 60, 195)
$g.DrawString("affects your home.", $hFont, $hBrush, 60, 288)
$hBrush.Dispose()

# ---- Sub text (word-wrapped) ----
$subFont = New-Object System.Drawing.Font ("Segoe UI", 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(195,206,219))
$subRect = New-Object System.Drawing.RectangleF 65, 420, 1000, 90
$sf = New-Object System.Drawing.StringFormat
$g.DrawString("How Florida Amendment 3 — a $150K homestead exemption in 2027, rising to $250K in 2028+ — would change property taxes across South Miami-Dade.", $subFont, $subBrush, $subRect, $sf)

# ---- Bottom-left stat ----
$statNumFont = New-Object System.Drawing.Font ("Segoe UI", 34, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$statSubFont = New-Object System.Drawing.Font ("Segoe UI", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$redBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,143,143))
$g.DrawString("`$194M in local revenue at stake", $statNumFont, $redBrush, 60, 542)
$g.DrawString("under the 2028+ `$250K homestead exemption (18 ZIPs, non-school)", $statSubFont, $mutBrush, 60, 585)

# ---- Bottom-right URL (gradient) ----
$urlFont = New-Object System.Drawing.Font ("Segoe UI", 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$urlText = "saveour.homes"
$urlSz = $g.MeasureString($urlText, $urlFont)
$urlX = $W - 60 - $urlSz.Width
$urlRect = New-Object System.Drawing.RectangleF $urlX, 555, $urlSz.Width, $urlSz.Height
$urlBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $urlRect, ([System.Drawing.Color]::FromArgb(70,166,255)), ([System.Drawing.Color]::FromArgb(45,212,191)), 0
$g.DrawString($urlText, $urlFont, $urlBrush, $urlX, 555)
$urlBrush.Dispose()

# Save JPEG (quality 92)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 92L
$bmp.Save($outPath, $codec, $encParams)

$g.Dispose(); $bmp.Dispose()
Write-Host "Wrote $outPath ($(([System.IO.FileInfo]$outPath).Length) bytes)"
