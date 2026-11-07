param(
  [string]$MarkSource,
  [string]$TileSource,
  [string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
function Export-Png([string]$source,[string]$target,[int]$size){
  $inputImage=[Drawing.Image]::FromFile($source)
  $bitmap=[Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try{
    $graphics.CompositingMode=[Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($inputImage,0,0,$size,$size)
    $bitmap.Save($target,[Drawing.Imaging.ImageFormat]::Png)
  }finally{$graphics.Dispose();$bitmap.Dispose();$inputImage.Dispose()}
}
Export-Png $MarkSource (Join-Path $ProjectRoot 'src\ui\assets\xray-logo.png') 256
Export-Png $MarkSource (Join-Path $ProjectRoot 'src\ui\brand.png') 256
Export-Png $TileSource (Join-Path $ProjectRoot 'desktop\app-icon.png') 256
Export-Png $TileSource (Join-Path $ProjectRoot 'desktop\tray.png') 32
$sizes=@(16,20,24,32,48,64,128,256)
$frames=@()
foreach($size in $sizes){
  $temp=Join-Path $ProjectRoot "desktop\icon-$size.png"
  Export-Png $TileSource $temp $size
  $frames+=,[IO.File]::ReadAllBytes($temp)
}
$stream=[IO.File]::Create((Join-Path $ProjectRoot 'desktop\app.ico'))
$writer=[IO.BinaryWriter]::new($stream)
try{
  $writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$sizes.Count)
  $offset=6+16*$sizes.Count
  for($i=0;$i -lt $sizes.Count;$i++){
    $value=if($sizes[$i] -eq 256){0}else{$sizes[$i]}
    $writer.Write([byte]$value);$writer.Write([byte]$value);$writer.Write([byte]0);$writer.Write([byte]0)
    $writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$frames[$i].Length);$writer.Write([uint32]$offset)
    $offset+=$frames[$i].Length
  }
  foreach($frame in $frames){$writer.Write([byte[]]$frame)}
}finally{$writer.Dispose();$stream.Dispose()}
Write-Output 'Exported application, tray, shortcut and multi-resolution Windows icon assets.'
