# img2png.ps1 —— 把任意格式的图（webp / jpg / heic / bmp / gif）转成 8bit PNG。
# 不装任何东西：用的是系统自带的 Windows.Graphics.Imaging（WinRT 包的 WIC），
# 实测本机 BitmapDecoder 能直接解 webp，所以 AI 工具发下来的 webp/jpg 不用先手工转一道。
#   -In <源图> -Out <目标.png> [-Status <状态.txt>]
#   目标 PNG 必须已经存在（空文件就行，Node 负责建）；WinRT 的 StorageFile 只开已有文件。
# 状态同时写 stdout 和 -Status 文件（UTF-8）：PowerShell 控制台是 GBK，中文报错到了 Node 会变乱码，
# 所以 probe 读的是状态文件。成功 "OK 宽x高"，失败 "ERR 原因" 并以 2 退出。
param([string] $In = '', [string] $Out = '', [string] $Status = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$op1 = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$act = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($o, $t) { $m = $op1.MakeGenericMethod($t); $x = $m.Invoke($null, @($o)); $x.Wait(-1) | Out-Null; $x.Result }
function AwaitA($o) { $x = $act.Invoke($null, @($o)); $x.Wait(-1) | Out-Null }
function Say($s) {
  if ($Status) { [IO.File]::WriteAllText($Status, $s, (New-Object Text.UTF8Encoding($false))) }
  Write-Output $s
}
foreach ($t in @('Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime',
                 'Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime',
                 'Windows.Graphics.Imaging.BitmapEncoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime',
                 'Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime')) {
  [void][Type]::GetType($t, $false)
}
try {
  if (-not $In -or -not $Out) { Say 'ERR 没给 -In 或 -Out'; exit 2 }
  $fin = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($In)) ([Windows.Storage.StorageFile])
  $sin = Await ($fin.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($sin)) ([Windows.Graphics.Imaging.BitmapDecoder])
  # 一律让解码器把像素摊成 Bgra8：编码器只认固定几种像素格式
  $bmp = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $fout = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Out)) ([Windows.Storage.StorageFile])
  $sout = Await ($fout.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  $enc = Await ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync(
    [Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId, $sout)) ([Windows.Graphics.Imaging.BitmapEncoder])
  $enc.SetSoftwareBitmap($bmp)
  AwaitA ($enc.FlushAsync())
  $sout.Dispose(); $sin.Dispose()
  Say ('OK ' + $bmp.PixelWidth + 'x' + $bmp.PixelHeight)
} catch {
  Say ('ERR ' + $_.Exception.Message)
  exit 2
}
