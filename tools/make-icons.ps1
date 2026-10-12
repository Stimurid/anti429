# Renders the static extension icons: dark rounded square, white "429" with an overline (= logical NOT).
# The live traffic-light icon is drawn at runtime by background.js (OffscreenCanvas); these are the install-time ones.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null
foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90); $path.AddArc(0, $size - $d, $d, $d, 90, 90); $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(27, 31, 42))), $path)
  $font = New-Object System.Drawing.Font('Segoe UI', [single]($size * 0.36), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('429', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, ($size * 0.0), $size, $size), $fmt)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single][Math]::Max(1, $size * 0.07))
  $g.DrawLine($pen, [single]($size * 0.14), [single]($size * 0.2), [single]($size * 0.86), [single]($size * 0.2))
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(46, 204, 113))), [single]($size * 0.68), [single]($size * 0.68), [single]($size * 0.26), [single]($size * 0.26))
  $bmp.Save((Join-Path $out "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
Get-ChildItem $out | Select-Object Name, Length
