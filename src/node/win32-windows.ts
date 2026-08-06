/**
 * Win32 window operations, driven through PowerShell + Add-Type.
 *
 * Electron's main process cannot call user32 directly and this project has no
 * native addon. A compiled C# snippet run via PowerShell is the cheapest way to
 * get EnumWindows/ShowWindow/SetForegroundWindow without adding a build
 * toolchain, and these calls only ever happen on an explicit user action, so
 * the ~200ms spawn cost is invisible.
 *
 * `SetForegroundWindow` is restricted: Windows only honours it for the process
 * that owns the current foreground window (or one it has delegated to). A
 * spawned PowerShell child does not inherit that right, so the script attaches
 * its input queue to the current foreground thread first — the standard
 * workaround — and verifies the result rather than assuming success.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const POWERSHELL = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Shared C# surface. Kept in one string so every call site gets the same API. */
const WIN32_TYPE = `
Add-Type -ErrorAction Stop @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class AIWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT minPosition; public POINT maxPosition; public RECT normalPosition;
  }
  public const int SW_RESTORE = 9, SW_SHOW = 5, SW_MAXIMIZE = 3;
  public const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;

  public static string FindByTitle(string needle) {
    var found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(1024); GetWindowTextW(h, t, 1024);
      if (t.ToString().IndexOf(needle, StringComparison.Ordinal) < 0) return true;
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      found.Add(((long)h) + "|" + c.ToString() + "|" + pid + "|" + t.ToString().Replace("|", " "));
      return true;
    }, IntPtr.Zero);
    return string.Join("\\n", found.ToArray());
  }

  public static bool IsMaximized(IntPtr h) {
    var p = new WINDOWPLACEMENT(); p.length = Marshal.SizeOf(p);
    if (!GetWindowPlacement(h, ref p)) return false;
    return p.showCmd == SW_MAXIMIZE;
  }

  /** Restore, optionally reposition, then raise. Returns a status string. */
  public static string Raise(long handle, bool doMove, int x, int y, int w, int hgt) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return "gone";

    bool wasMax = IsMaximized(h);
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);

    if (doMove) {
      // A maximized window ignores SetWindowPos; drop it to restored, move it,
      // then re-maximize so it fills the *target* monitor rather than the old one.
      if (wasMax) ShowWindow(h, SW_RESTORE);
      RECT r; GetWindowRect(h, out r);
      int cw = r.R - r.L, ch = r.B - r.T;
      if (cw > w) cw = w;
      if (ch > hgt) ch = hgt;
      int nx = x + (w - cw) / 2, ny = y + (hgt - ch) / 2;
      SetWindowPos(h, IntPtr.Zero, nx, ny, cw, ch, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      if (wasMax) ShowWindow(h, SW_MAXIMIZE);
    } else if (!IsWindowVisible(h)) {
      ShowWindow(h, SW_SHOW);
    }

    // Borrow the foreground thread's input queue so SetForegroundWindow is honoured.
    IntPtr fg = GetForegroundWindow();
    uint fgPid; uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);

    IntPtr now = GetForegroundWindow();
    return (now == h ? "foreground" : (ok ? "raised" : "raised-not-foreground"));
  }
}
"@
`

export interface FoundWindow {
  hwnd: number
  className: string
  pid: number
  title: string
}

async function runPowerShell(script: string, timeoutMs = 12_000): Promise<string> {
  const { stdout } = await execFileAsync(POWERSHELL, [...PS_ARGS, script], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  })
  return stdout
}

/** Locate visible windows whose title contains `needle`. */
export async function findWindowsByTitle(needle: string): Promise<FoundWindow[]> {
  if (process.platform !== 'win32' || !needle) return []
  const safe = needle.replace(/'/g, "''")
  const out = await runPowerShell(`${WIN32_TYPE}\n[AIWin]::FindByTitle('${safe}')`)
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hwnd, className, pid, ...rest] = line.split('|')
      return {
        hwnd: Number(hwnd),
        className: className ?? '',
        pid: Number(pid),
        title: rest.join('|')
      }
    })
    .filter((w) => Number.isFinite(w.hwnd) && w.hwnd > 0)
}

export type RaiseOutcome = 'foreground' | 'raised' | 'raised-not-foreground' | 'gone' | 'error'

export interface RaiseTarget {
  hwnd: number
  /** Work area to move the window into. Omit to leave the window where it is. */
  moveTo?: { x: number; y: number; width: number; height: number }
}

/**
 * Restore + optionally relocate + focus an existing window. Never creates one.
 * `gone` means the HWND no longer exists — the caller must treat the session as
 * closed rather than silently doing nothing.
 */
export async function raiseWindow(target: RaiseTarget): Promise<RaiseOutcome> {
  if (process.platform !== 'win32') return 'error'
  if (!Number.isFinite(target.hwnd) || target.hwnd <= 0) return 'gone'
  const m = target.moveTo
  const args = m
    ? `${target.hwnd}, $true, ${Math.round(m.x)}, ${Math.round(m.y)}, ${Math.round(m.width)}, ${Math.round(m.height)}`
    : `${target.hwnd}, $false, 0, 0, 0, 0`
  try {
    const out = (await runPowerShell(`${WIN32_TYPE}\n[AIWin]::Raise(${args})`)).trim()
    if (out === 'foreground' || out === 'raised' || out === 'raised-not-foreground' || out === 'gone') {
      return out
    }
    return 'error'
  } catch (error) {
    console.warn('raiseWindow failed:', error)
    return 'error'
  }
}

/** Screen rect of a foreign window, used to decide whether it needs moving. */
export async function getWindowRect(
  hwnd: number
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (process.platform !== 'win32' || !Number.isFinite(hwnd) || hwnd <= 0) return null
  try {
    const out = await runPowerShell(
      `${WIN32_TYPE}\n$r = New-Object AIWin+RECT; if ([AIWin]::GetWindowRect([IntPtr]${hwnd}, [ref]$r)) { "$($r.L),$($r.T),$($r.R),$($r.B)" }`
    )
    const parts = out.trim().split(',').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
    const [l, t, r, b] = parts
    return { x: l, y: t, width: r - l, height: b - t }
  } catch {
    return null
  }
}

/**
 * Activate a specific tab inside a terminal window, by its tab title.
 *
 * Windows Terminal exposes each tab as a UI Automation `TabItem` supporting
 * `SelectionItemPattern`, so a tab really can be activated from another
 * process — verified switching a three-tab window between named tabs. There is
 * no equivalent for conhost or mintty, which have no tabs at all, so a `false`
 * return simply means the caller should settle for raising the window.
 */
export async function focusTabByTitle(hwnd: number, tabTitle: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (!Number.isFinite(hwnd) || hwnd <= 0 || !tabTitle) return false
  const safe = tabTitle.replace(/'/g, "''")
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd})
if (-not $root) { 'no'; exit }
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$hit = $null
foreach ($t in $tabs) { if ($t.Current.Name -eq '${safe}') { $hit = $t; break } }
if (-not $hit) { 'no'; exit }
try {
  $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  'yes'
} catch { 'no' }
`
  // The agent is repainting its title the whole time, so the marker may lose a
  // race. Retry briefly rather than silently settling for the wrong tab.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if ((await runPowerShell(script)).trim() === 'yes') return true
    } catch {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 180))
  }
  return false
}

/**
 * Handle of the window the user is currently working in. Used to stay quiet
 * when a prompt arrives in a terminal they are already looking at.
 */
export async function foregroundWindow(): Promise<number | null> {
  if (process.platform !== 'win32') return null
  try {
    const out = await runPowerShell(`${WIN32_TYPE}\n[int64][AIWin]::GetForegroundWindow()`)
    const value = Number(out.trim())
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Cheap liveness check used when validating registry entries. */
export async function windowExists(hwnd: number): Promise<boolean> {
  if (process.platform !== 'win32' || !Number.isFinite(hwnd) || hwnd <= 0) return false
  try {
    const out = await runPowerShell(
      `${WIN32_TYPE}\nif ([AIWin]::IsWindow([IntPtr]${hwnd})) { 'yes' } else { 'no' }`
    )
    return out.trim() === 'yes'
  } catch {
    return false
  }
}

export function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
