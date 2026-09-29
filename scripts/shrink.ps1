param(
  [Parameter(Mandatory=$true)][string]$Image,
  [string]$Out = "",
  [int]$MaxWidth = 1600,
  [int]$Quality = 82
)
# 读尺寸 / （给了 -Out 时）等比缩到 MaxWidth 以内并存成 JPEG
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing
$path = (Resolve-Path $Image).Path
$img = [System.Drawing.Image]::FromFile($path)
if (-not $Out) {
  Write-Output ("{0}x{1}" -f $img.Width, $img.Height)
  $img.Dispose(); return
}
$w = $img.Width; $h = $img.Height
if ($w -le $MaxWidth) { $nw = $w; $nh = $h } else { $nw = $MaxWidth; $nh = [int][math]::Round($h * ($MaxWidth / $w)) }
$bmp = New-Object System.Drawing.Bitmap($nw, $nh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.DrawImage($img, 0, 0, $nw, $nh)
$g.Dispose(); $img.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$bmp.Save($Out, $codec, $ep)
Write-Output ("OK {0}x{1} -> {2}" -f $nw, $nh, $Out)
$bmp.Dispose()
