<#
Screen capture helper for the dsh-screenshot plugin.

Minimizes the DSH window that owns the calling Host process, grabs the whole
virtual desktop once, and then either saves it whole (Mode 0) or lets the user
drag a rectangle over a dimmed copy of it (Mode 1) and saves that crop.

Exit codes: 0 saved, 2 cancelled by the user, anything else failed.

ASCII only: the plugin writes this file as UTF-8 without BOM and older hosts
read it as ANSI. The overlay hint arrives as a -Hint argument instead.
#>
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$WindowPid = 0,
  [int]$MaxWidth = 1920,
  [int]$SettleMs = 650,
  [int]$HideWindow = 1,
  [int]$Mode = 1,
  [string]$Hint = ''
)

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class DshShotNative
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
'@

$selectorSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public class DshShotSelector : Form
{
    private Bitmap screen;
    private string hint;
    private Point anchor;
    private Point cursor;
    private bool dragging;

    public Rectangle Chosen = Rectangle.Empty;
    public bool Cancelled = true;

    public DshShotSelector(Bitmap source, Rectangle bounds, string hintText)
    {
        screen = source;
        hint = hintText;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        TopMost = true;
        ShowInTaskbar = false;
        Cursor = Cursors.Cross;
        DoubleBuffered = true;
        KeyPreview = true;
        BackColor = Color.Black;
    }

    private Rectangle SelectionRect()
    {
        int x1 = Math.Min(anchor.X, cursor.X);
        int y1 = Math.Min(anchor.Y, cursor.Y);
        int x2 = Math.Max(anchor.X, cursor.X);
        int y2 = Math.Max(anchor.Y, cursor.Y);
        Rectangle r = Rectangle.FromLTRB(x1, y1, x2, y2);
        r.Intersect(ClientRectangle);
        return r;
    }

    private void DrawBadge(Graphics g, string text, float x, float y, Font font)
    {
        SizeF size = g.MeasureString(text, font);
        using (SolidBrush back = new SolidBrush(Color.FromArgb(205, 14, 18, 28)))
        {
            g.FillRectangle(back, x, y, size.Width + 14f, size.Height + 8f);
        }
        using (SolidBrush ink = new SolidBrush(Color.FromArgb(245, 255, 255, 255)))
        {
            g.DrawString(text, font, ink, x + 7f, y + 4f);
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.DrawImage(screen, new Rectangle(0, 0, ClientSize.Width, ClientSize.Height), new Rectangle(0, 0, screen.Width, screen.Height), GraphicsUnit.Pixel);

        using (SolidBrush dim = new SolidBrush(Color.FromArgb(120, 8, 12, 20)))
        {
            g.FillRectangle(dim, ClientRectangle);
        }

        if (hint != null && hint.Length > 0)
        {
            using (Font hintFont = new Font("Microsoft YaHei UI", 11f))
            {
                SizeF hintSize = g.MeasureString(hint, hintFont);
                float hintX = (ClientSize.Width - hintSize.Width) / 2f - 7f;
                if (hintX < 12f) hintX = 12f;
                DrawBadge(g, hint, hintX, 24f, hintFont);
            }
        }

        Rectangle r = SelectionRect();
        if (r.Width > 0 && r.Height > 0)
        {
            g.DrawImage(screen, r, new Rectangle(r.X, r.Y, r.Width, r.Height), GraphicsUnit.Pixel);
            using (Pen border = new Pen(Color.FromArgb(255, 92, 168, 255), 2f))
            {
                g.DrawRectangle(border, r);
            }
            string label = r.Width.ToString() + " x " + r.Height.ToString();
            using (Font labelFont = new Font("Segoe UI", 9f))
            {
                SizeF labelSize = g.MeasureString(label, labelFont);
                float labelX = r.X + 4f;
                float labelY = r.Y + 4f;
                if (labelY + labelSize.Height + 10f > ClientSize.Height) labelY = r.Y - labelSize.Height - 10f;
                if (labelX + labelSize.Width + 18f > ClientSize.Width) labelX = ClientSize.Width - labelSize.Width - 26f;
                if (labelY < 0f) labelY = r.Y + 4f;
                DrawBadge(g, label, labelX, labelY, labelFont);
            }
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Right)
        {
            Cancelled = true;
            Close();
            return;
        }
        if (e.Button == MouseButtons.Left)
        {
            anchor = e.Location;
            cursor = e.Location;
            dragging = true;
            Invalidate();
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (dragging)
        {
            cursor = e.Location;
            Invalidate();
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (!dragging || e.Button != MouseButtons.Left)
        {
            base.OnMouseUp(e);
            return;
        }
        dragging = false;
        cursor = e.Location;
        Rectangle r = SelectionRect();
        if (r.Width < 8 || r.Height < 8)
        {
            Cancelled = true;
        }
        else
        {
            Chosen = r;
            Cancelled = false;
        }
        Close();
        base.OnMouseUp(e);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape)
        {
            Cancelled = true;
            Close();
        }
        base.OnKeyDown(e);
    }
}
'@

Add-Type -TypeDefinition $nativeSource
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Compiling the selector with csc costs seconds on a cold machine, so keep the
# built assembly around. Bump the version suffix whenever the C# above changes.
$selectorVersion = 'v1'
$cacheDir = Join-Path $env:TEMP 'dsh-screenshot'
$cacheDll = Join-Path $cacheDir ("selector-$selectorVersion.dll")
$selectorLoaded = $false
if (Test-Path -LiteralPath $cacheDll) {
  try {
    Add-Type -Path $cacheDll
    $selectorLoaded = $true
  } catch {
    Remove-Item -LiteralPath $cacheDll -Force -ErrorAction SilentlyContinue
  }
}
if (-not $selectorLoaded) {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  Add-Type -TypeDefinition $selectorSource -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $cacheDll -OutputType Library
  Add-Type -Path $cacheDll
}

[void][DshShotNative]::SetProcessDPIAware()

# SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN / SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN
$originX = [DshShotNative]::GetSystemMetrics(76)
$originY = [DshShotNative]::GetSystemMetrics(77)
$width = [DshShotNative]::GetSystemMetrics(78)
$height = [DshShotNative]::GetSystemMetrics(79)
if ($width -le 0 -or $height -le 0) {
  throw 'no screen metrics available'
}

# Walk up from the calling Host process until a process owns a top-level window.
$handle = [IntPtr]::Zero
if ($HideWindow -ne 0 -and $WindowPid -gt 0) {
  try {
    $chain = New-Object System.Collections.Generic.List[int]
    $cursor = $WindowPid
    while ($cursor -gt 0 -and $chain.Count -lt 8) {
      $row = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$cursor" -ErrorAction Stop
      if ($null -eq $row) { break }
      $chain.Add([int]$row.ProcessId)
      $cursor = [int]$row.ParentProcessId
    }
    foreach ($id in $chain) {
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($null -ne $proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $handle = $proc.MainWindowHandle
        break
      }
    }
  } catch {
    $handle = [IntPtr]::Zero
  }
}

$minimized = $false
$cancelled = $false
$bitmap = $null
try {
  if ($handle -ne [IntPtr]::Zero -and -not [DshShotNative]::IsIconic($handle)) {
    [void][DshShotNative]::ShowWindow($handle, 6)
    $minimized = $true
    Start-Sleep -Milliseconds $SettleMs
  }

  $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($originX, $originY, 0, 0, $bitmap.Size)
  } finally {
    $graphics.Dispose()
  }

  if ($Mode -eq 1) {
    $bounds = New-Object System.Drawing.Rectangle -ArgumentList $originX, $originY, $width, $height
    $selector = New-Object DshShotSelector -ArgumentList @($bitmap, $bounds, $Hint)
    [System.Windows.Forms.Application]::Run($selector)
    if ($selector.Cancelled -or $selector.Chosen.Width -le 0 -or $selector.Chosen.Height -le 0) {
      $cancelled = $true
    } else {
      $rect = $selector.Chosen
      $crop = New-Object System.Drawing.Bitmap -ArgumentList $rect.Width, $rect.Height
      $cropGraphics = [System.Drawing.Graphics]::FromImage($crop)
      try {
        $target = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $rect.Width, $rect.Height
        $cropGraphics.DrawImage($bitmap, $target, $rect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally {
        $cropGraphics.Dispose()
      }
      $bitmap.Dispose()
      $bitmap = $crop
    }
    $selector.Dispose()
  }

  if (-not $cancelled -and $MaxWidth -gt 0 -and $bitmap.Width -gt $MaxWidth) {
    $ratio = $MaxWidth / $bitmap.Width
    $scaledWidth = [int][Math]::Round($bitmap.Width * $ratio)
    $scaledHeight = [int][Math]::Round($bitmap.Height * $ratio)
    $scaled = New-Object System.Drawing.Bitmap -ArgumentList $scaledWidth, $scaledHeight
    $scaler = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $scaler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scaler.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scaler.DrawImage($bitmap, 0, 0, $scaledWidth, $scaledHeight)
    } finally {
      $scaler.Dispose()
    }
    $bitmap.Dispose()
    $bitmap = $scaled
  }

  if (-not $cancelled) {
    $bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} finally {
  if ($null -ne $bitmap) {
    $bitmap.Dispose()
  }
  if ($minimized) {
    [void][DshShotNative]::ShowWindow($handle, 9)
    [void][DshShotNative]::SetForegroundWindow($handle)
  }
}

if ($cancelled) {
  exit 2
}
Write-Output 'ok'
