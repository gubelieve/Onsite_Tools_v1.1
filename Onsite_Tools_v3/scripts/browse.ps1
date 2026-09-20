# Native file / folder picker for the Browse buttons (see src/app/api/browse/route.ts).
#
# The dialog is opened by the web server process, which is NOT the foreground application, so Windows refuses it
# focus: it opens behind the browser or only blinks in the taskbar. To land on top we
#   1. create a real (1x1, transparent, TopMost) owner window and show it,
#   2. borrow the input queue of the current foreground window (AttachThreadInput) - the documented way to get
#      around the foreground lock - and push the owner to the front,
#   3. open the dialog owned by that window, so it inherits the position and the TopMost flag.
#
# Dialog text arrives in environment variables (ONSITE_TITLE / ONSITE_FILTER / ONSITE_KIND), never as script text.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OnsiteFg {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr procId);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    public static void Force(IntPtr hWnd) {
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != myThread && AttachThreadInput(fgThread, myThread, true);
        try {
            ShowWindow(hWnd, 5);   // SW_SHOW
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        } finally {
            if (attached) AttachThreadInput(fgThread, myThread, false);
        }
    }
}
'@

$owner = New-Object System.Windows.Forms.Form -Property @{
    TopMost         = $true
    ShowInTaskbar   = $false
    FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    StartPosition   = [System.Windows.Forms.FormStartPosition]::CenterScreen
    Size            = New-Object System.Drawing.Size 1, 1
    Opacity         = 0.01   # invisible in practice, but a real window Windows will activate
}
$owner.Show()
$owner.Activate()
[OnsiteFg]::Force($owner.Handle)
[System.Windows.Forms.Application]::DoEvents()

try {
    if ($env:ONSITE_KIND -eq 'folder') {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = $env:ONSITE_TITLE
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            [Console]::Out.Write($dialog.SelectedPath)
        }
    } else {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = $env:ONSITE_TITLE
        $dialog.Filter = $env:ONSITE_FILTER
        $dialog.CheckFileExists = $true
        $dialog.Multiselect = $false
        if ($env:ONSITE_INITIAL -and (Test-Path -LiteralPath $env:ONSITE_INITIAL)) {
            $dialog.InitialDirectory = $env:ONSITE_INITIAL
        }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            [Console]::Out.Write($dialog.FileName)
        }
    }
} finally {
    $owner.Close()
    $owner.Dispose()
}
