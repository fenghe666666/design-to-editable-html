param(
  [Parameter(Mandatory=$true)][string]$Png,
  [Parameter(Mandatory=$true)][string]$Jpg,
  [int]$Quality = 92,
  [string]$Background = ""
)
# PNG -> JPG（可指定压平底色，用于透明文字层）
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Png).Path)
$dst = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
if ($Background) {
  $c = [System.Drawing.ColorTranslator]::FromHtml($Background)
  $g.Clear($c)
} else {
  $g.Clear([System.Drawing.Color]::White)
}
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $src.Width, $src.Height)
$g.Dispose(); $src.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$dst.Save($Jpg, $codec, $ep)
Write-Output ("OK {0}x{1} -> {2}" -f $dst.Width, $dst.Height, $Jpg)
$dst.Dispose()
