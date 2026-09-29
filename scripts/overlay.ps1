param(
  [Parameter(Mandatory=$true)][string]$Render,
  [Parameter(Mandatory=$true)][string]$Reference,
  [string]$OverlayOut = "",
  [string]$DiffOut = "",
  [int]$Threshold = 40,
  [int]$Step = 2
)
# 还原度校验：把渲染图和参考图对到同一尺寸，输出差异统计 + 叠影图 + 差异热图
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;

public static class ImageDiffLoop {
  public static long[] Measure(byte[] render, byte[] reference, byte[] diff,
    int width, int height, int stride, int threshold, int step) {
    long sum = 0, count = 0, bad = 0;
    for (int y = 0; y < height; y += step) {
      int row = y * stride;
      for (int x = 0; x < width; x += step) {
        int i = row + x * 4;
        int d = Math.Abs((int)render[i] - reference[i])
          + Math.Abs((int)render[i + 1] - reference[i + 1])
          + Math.Abs((int)render[i + 2] - reference[i + 2]);
        sum += d;
        count++;
        if (d > threshold) bad++;
        if (diff != null) {
          byte value = (byte)Math.Min(255, d);
          byte green = Convert.ToByte(Math.Min(255, value * 0.2));
          diff[i] = 0; diff[i + 1] = green; diff[i + 2] = value; diff[i + 3] = 255;
          for (int k = 1; k < step && x + k < width; k++) {
            int j = i + k * 4;
            diff[j] = 0; diff[j + 1] = green; diff[j + 2] = value; diff[j + 3] = 255;
          }
        }
      }
    }
    return new long[] { sum, count, bad };
  }
}
'@

function To32([string]$p) {
  $src = [System.Drawing.Image]::FromFile($p)
  $b = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
  $g.Dispose(); $src.Dispose()
  return $b
}
function Load([string]$p, [int]$w, [int]$h) {
  $b = To32 $p
  if ($b.Width -eq $w -and $b.Height -eq $h) { return $b }
  $r = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($r)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($b, 0, 0, $w, $h)
  $g.Dispose(); $b.Dispose()
  return $r
}
function Lock($bmp) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $n = [math]::Abs($bd.Stride) * $bd.Height
  $buf = New-Object byte[] $n
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $n)
  $bmp.UnlockBits($bd)
  return @{ b = $buf; stride = $bd.Stride }
}

$a = To32 $Render
$W = $a.Width; $H = $a.Height
$b = Load $Reference $W $H
Write-Output ("对齐尺寸 {0}x{1}（参考图已缩放到渲染图尺寸）" -f $W, $H)

if ($OverlayOut) {
  $o = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($o)
  $g.DrawImage($a, 0, 0)
  $cm = New-Object System.Drawing.Imaging.ColorMatrix
  $cm.Matrix33 = 0.5
  $ia = New-Object System.Drawing.Imaging.ImageAttributes
  $ia.SetColorMatrix($cm)
  $g.DrawImage($b, (New-Object System.Drawing.Rectangle(0, 0, $W, $H)), 0, 0, $W, $H, [System.Drawing.GraphicsUnit]::Pixel, $ia)
  $g.Dispose(); $o.Save($OverlayOut); $o.Dispose()
  Write-Output ("叠影图 -> " + $OverlayOut)
}

$la = Lock $a; $lb = Lock $b
$sa = $la.b; $sb = $lb.b; $st = $la.stride
$df = $null
if ($DiffOut) { $df = New-Object byte[] ($st * $H) }
$stats = [ImageDiffLoop]::Measure($sa, $sb, $df, $W, $H, $st, $Threshold, $Step)
$sum = [double]$stats[0]; $n = [double]$stats[1]; $bad = [double]$stats[2]
if ($DiffOut) {
  $dm = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
  $bd = $dm.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  [System.Runtime.InteropServices.Marshal]::Copy($df, 0, $bd.Scan0, $df.Length)
  $dm.UnlockBits($bd)
  $dm.Save($DiffOut); $dm.Dispose()
  Write-Output ("差异热图 -> " + $DiffOut)
}
$a.Dispose(); $b.Dispose()
$pct = [math]::Round($bad / $n * 100, 2)
$mean = [math]::Round($sum / $n / 3, 1)
Write-Output ("平均通道差 {0} / 255 · 明显差异像素 {1}%（阈值 {2}/像素）" -f $mean, $pct, $Threshold)
if ($pct -lt 3) { Write-Output "判定：高度一致" }
elseif ($mean -lt 15 -and $pct -le 11) {
  Write-Output "判定：版面已吻合，剩余差异集中在字形（AI 参考图的字体与任何本机字体都不同源，明显差异像素 8~11% 是正常下限）"
  Write-Output "        看热图：文字处只剩一片模糊 = 已到位；文字处仍有成形字影 = 该处 x/y/字号/字体还没对上"
}
else { Write-Output "判定：偏差明显，先查底板是否残留文字，再查字体、字号与 x/y 偏移" }
