# Puts a count on the taskbar button of the window that hosts this DSH app (the Desktop window), as a red overlay badge.
# Walks up the process tree from -StartPid to the first process with a visible main window, then asks the shell
# (ITaskbarList3::SetOverlayIcon) to show a badge with -Count; -Count 0 removes it. Exit codes: 0 done, 3 no window found, 4 failed.
# Kept pure ASCII: Windows PowerShell 5.1 misreads BOM-less UTF-8 source.
param(
    [Parameter(Mandatory)][int]$StartPid,
    [Parameter(Mandatory)][int]$Count
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
public class CTaskbarList { }
[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList3 {
    [PreserveSig] int HrInit();
    [PreserveSig] int AddTab(IntPtr hwnd);
    [PreserveSig] int DeleteTab(IntPtr hwnd);
    [PreserveSig] int ActivateTab(IntPtr hwnd);
    [PreserveSig] int SetActiveAlt(IntPtr hwnd);
    [PreserveSig] int MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
    [PreserveSig] int SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
    [PreserveSig] int SetProgressState(IntPtr hwnd, int flags);
    [PreserveSig] int RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
    [PreserveSig] int UnregisterTab(IntPtr hwndTab);
    [PreserveSig] int SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
    [PreserveSig] int SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint reserved);
    [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
    [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
    [PreserveSig] int ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
    [PreserveSig] int SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string description);
    [PreserveSig] int SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string tip);
    [PreserveSig] int SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
}
public static class Native {
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
    public static int SetOverlay(IntPtr hwnd, IntPtr hIcon, string description) {
        ITaskbarList3 list = (ITaskbarList3)new CTaskbarList();
        list.HrInit();
        return list.SetOverlayIcon(hwnd, hIcon, description);
    }
}
'@

function Find-WindowHandle([int]$ProcessId) {
    for ($i = 0; $i -lt 8 -and $ProcessId -gt 4; $i++) {
        $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
        if (-not $parent) { return [IntPtr]::Zero }
        $ProcessId = [int]$parent.ParentProcessId
    }
    return [IntPtr]::Zero
}

function New-BadgeIcon([int]$Number) {
    $text = if ($Number -gt 9) { '9+' } else { [string]$Number }
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 220, 38, 38))), 0, 0, 31, 31)
    $size = if ($text.Length -gt 1) { 15 } else { 20 }
    $font = New-Object System.Drawing.Font 'Segoe UI', $size, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = 'Center'; $format.LineAlignment = 'Center'
    $g.DrawString($text, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $format)
    $g.Dispose()
    return $bmp.GetHicon()
}

$hwnd = Find-WindowHandle $StartPid
if ($hwnd -eq [IntPtr]::Zero) { exit 3 }
if ($Count -le 0) {
    $hr = [Native]::SetOverlay($hwnd, [IntPtr]::Zero, '')
} else {
    $icon = New-BadgeIcon $Count
    $label = if ($Count -eq 1) { '1 item waiting in the Coding Boss Review Queue' } else { "$Count items waiting in the Coding Boss Review Queue" }
    $hr = [Native]::SetOverlay($hwnd, $icon, $label)
    [void][Native]::DestroyIcon($icon)
}
if ($hr -ne 0) { [Console]::Error.WriteLine('SetOverlayIcon failed: 0x{0:X8}' -f $hr); exit 4 }
exit 0
