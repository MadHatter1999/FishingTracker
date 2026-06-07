#requires -Version 5.1
<#
  Runs the guild backend (Node + SQLite) and the frontend (Vite) together in
  ONE terminal, and guarantees both shut down when this script stops by ANY
  method:
    - Ctrl+C            -> finally block kills both (and Ctrl+C also reaches the
                           child node processes via the shared console)
    - window closed / Stop-Process / taskkill / crash
                        -> a Windows Job Object with KILL_ON_JOB_CLOSE kills the
                           whole child tree (vite, node, esbuild) when this
                           process's handle is released.

  Usage:  .\dev.ps1     (from the project root)
#>
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# --- install dependencies on first run ---
if (-not (Test-Path "node_modules")) { Write-Host "Installing frontend deps..." -ForegroundColor DarkGray; npm install }
if (-not (Test-Path "server/node_modules")) { Write-Host "Installing server deps..." -ForegroundColor DarkGray; Push-Location server; npm install; Pop-Location }

# --- Job Object: children die with this process no matter how it is killed ---
$cs = @'
using System;
using System.Runtime.InteropServices;
public static class GuildJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint cb);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong a, b, c, d, e, f;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    const int ExtendedLimitInformation = 9;
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    static IntPtr _job = IntPtr.Zero;

    public static void Init() {
        _job = CreateJobObject(IntPtr.Zero, null);
        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(ext);
        IntPtr p = Marshal.AllocHGlobal(len);
        Marshal.StructureToPtr(ext, p, false);
        SetInformationJobObject(_job, ExtendedLimitInformation, p, (uint)len);
        Marshal.FreeHGlobal(p);
    }
    public static void Assign(IntPtr handle) {
        if (_job != IntPtr.Zero) { AssignProcessToJobObject(_job, handle); }
    }
}
'@
try { Add-Type -TypeDefinition $cs -Language CSharp; [GuildJob]::Init() } catch { Write-Host "Job object unavailable; relying on Ctrl+C cleanup." -ForegroundColor DarkYellow }

$be = $null
$fe = $null
try {
    Write-Host "Starting backend  -> http://localhost:8787" -ForegroundColor Cyan
    $be = Start-Process -FilePath "node" -ArgumentList @("--no-warnings=ExperimentalWarning", "server/index.js") -NoNewWindow -PassThru
    try { [GuildJob]::Assign($be.Handle) } catch {}

    Write-Host "Starting frontend -> http://localhost:5180" -ForegroundColor Cyan
    $fe = Start-Process -FilePath "node" -ArgumentList @("node_modules/vite/bin/vite.js") -NoNewWindow -PassThru
    try { [GuildJob]::Assign($fe.Handle) } catch {}

    Write-Host "`nBoth running. Press Ctrl+C to stop BOTH.`n" -ForegroundColor Green

    # Wait until either process exits, then fall through to cleanup.
    while ((-not $be.HasExited) -and (-not $fe.HasExited)) { Start-Sleep -Milliseconds 400 }
}
finally {
    Write-Host "`nStopping frontend + backend..." -ForegroundColor Yellow
    foreach ($p in @($fe, $be)) {
        if ($p -and -not $p.HasExited) {
            try { $p.Kill($true) } catch { try { $p.Kill() } catch {} }
        }
    }
    Write-Host "Stopped." -ForegroundColor Yellow
}
