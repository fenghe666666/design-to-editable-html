param([string]$Chars, [string]$Fams, [string]$Out, [string]$Map, [int]$Px = 64, [int]$Cell = 76)
# 把「字符 × 字体」画成一张表格图，给 fontid.cjs 逐字比字形用。
# 一个字体一行、一个字符一列；字符表和字体表是「一行一个」的纯文本（PS5.1 的 ConvertFrom-Json 会把数组读成一个字符串，所以不走 JSON）。
# 节点侧按格子取墨迹外接框再归一到 32×32，所以格子里怎么居中不用管。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$txt = [System.IO.File]::ReadAllText($Chars, [System.Text.Encoding]::UTF8)
$fa = [System.IO.File]::ReadAllText($Fams, [System.Text.Encoding]::UTF8)
$cs = @($txt -split "\r\n|\n|\r" | Where-Object { $_ -ne '' })
$fs = @($fa -split "\r\n|\n|\r" | Where-Object { $_ -ne '' })
$cols = $cs.Count; $rows = $fs.Count
if ($cols -lt 1 -or $rows -lt 1) { throw ('字符表 ' + $cols + ' 个、字体表 ' + $rows + ' 个 —— 有一个是空的') }
$bm = New-Object System.Drawing.Bitmap ($cols * $Cell), ($rows * $Cell)
$g = [System.Drawing.Graphics]::FromImage($bm)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$have = @{}
$coll = New-Object System.Drawing.Text.InstalledFontCollection
foreach ($ff in $coll.Families) { $have[$ff.Name.ToLower()] = $ff.Name }
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("cell`t$Cell`tpx`t$Px`tcols`t$cols")
for ($r = 0; $r -lt $rows; $r++) {
  $want = [string]$fs[$r]
  if (-not $have.ContainsKey($want.ToLower())) { [void]$lines.Add("-1`t$want`t本机没这个家族"); continue }
  $name = $have[$want.ToLower()]
  $font = New-Object System.Drawing.Font($name, $Px, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $act = [string]$font.Name
  for ($c = 0; $c -lt $cols; $c++) {
    $sz = $g.MeasureString([string]$cs[$c], $font)
    $x = $c * $Cell + ($Cell - $sz.Width) / 2
    $y = $r * $Cell + ($Cell - $sz.Height) / 2
    $g.DrawString([string]$cs[$c], $font, [System.Drawing.Brushes]::Black, [single]$x, [single]$y)
  }
  $font.Dispose()
  [void]$lines.Add("$r`t$want`t$act")
}
$g.Dispose()
$bm.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bm.Dispose()
[System.IO.File]::WriteAllLines($Map, [string[]]$lines, (New-Object System.Text.UTF8Encoding($true)))
Write-Output ("cells " + $cols + "x" + $rows)
