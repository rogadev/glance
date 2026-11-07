// paint.exe: the Windows side of glance. Claude Code starts hooks with their
// own hidden console, so a hook can't paint or read the visible pane directly.
// This helper attaches to the console of the claude.exe that owns the pane.
//
// Modes:
//   paint.exe <osc-body> [claude-pid]   Write ESC ] <osc-body> BEL to the pane,
//                                        for example "11;#1F2D3D" or "111".
//   paint.exe --pid                      Print the nearest claude.exe ancestor's pid.
//   paint.exe --title <claude-pid>       Print that pane's title (diagnostic).
//   paint.exe --utc-offset               Print the local UTC offset in minutes.
//   paint.exe --source-hash              Print the SHA-256 of the paint.cs this was
//                                        built from (LF line endings); CI checks it.
//   paint.exe --watch <claude-pid> <session-id> <state-file> <node-exe> <glance.mjs>
//       Long-lived. Watches the pane's title, which Claude Code sets to a spinner
//       while it works and to U+2733 when idle. When the title has been idle for
//       IdleConfirmMs while the state file still says working, it reports a
//       TitleIdle event to glance.mjs, which decides whether to act. This catches
//       Esc interrupts, which fire no hook. Exits when Claude exits or the state
//       file is gone.
//
// Exit codes: 0 ok, 2 bad args, 3 no claude.exe ancestor, 4 attach failed,
//             5 open CONOUT$ failed, 6 write failed.
// Build: build.ps1 (uses the .NET Framework csc.exe that ships with Windows).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Paint
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    delegate bool CtrlHandler(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(CtrlHandler handler, bool add);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitleW(StringBuilder buf, uint size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr h, byte[] buf, uint len, out uint written, IntPtr overlapped);

    const uint TH32CS_SNAPPROCESS = 0x2;
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    const uint SYNCHRONIZE = 0x00100000, WAIT_TIMEOUT = 0x102;
    const char IdleGlyph = '✳';
    const int PollMs = 750, IdleConfirmMs = 2500, ReportEveryMs = 5000, MissingStateMs = 15000;
    static readonly IntPtr INVALID = new IntPtr(-1);

    static uint FindClaudeAncestor()
    {
        var parent = new Dictionary<uint, uint>();
        var name = new Dictionary<uint, string>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID) return 0;
        var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
        for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
        {
            parent[e.th32ProcessID] = e.th32ParentProcessID;
            name[e.th32ProcessID] = e.szExeFile;
        }
        CloseHandle(snap);

        uint pid = GetCurrentProcessId();
        for (int depth = 0; depth < 16 && parent.ContainsKey(pid); depth++)
        {
            pid = parent[pid];
            string n;
            if (name.TryGetValue(pid, out n) && string.Equals(n, "claude.exe", StringComparison.OrdinalIgnoreCase)) return pid;
        }
        return 0;
    }

    static int Write(string body, uint claude)
    {
        if (claude == 0) claude = FindClaudeAncestor();
        if (claude == 0) return 3;
        FreeConsole();
        if (!AttachConsole(claude)) return 4;
        IntPtr h = CreateFileW("CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == INVALID) return 5;
        byte[] seq = Encoding.ASCII.GetBytes("\x1b]" + body + "\x07");
        uint written;
        bool ok = WriteFile(h, seq, (uint)seq.Length, out written, IntPtr.Zero);
        CloseHandle(h);
        FreeConsole();
        return ok && written == seq.Length ? 0 : 6;
    }

    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

    // Kept alive for the life of the process so the GC never collects the callback.
    static readonly CtrlHandler IgnoreCtrl = delegate { return true; };

    static int Watch(uint claude, string sessionId, string stateFile, string nodeExe, string glanceMjs)
    {
        IntPtr proc = OpenProcess(SYNCHRONIZE, false, claude);
        if (proc == IntPtr.Zero) { WatchLog(stateFile, "open-process failed"); return 3; }
        FreeConsole();
        if (!AttachConsole(claude)) { WatchLog(stateFile, "attach failed " + Marshal.GetLastWin32Error()); return 4; }
        // Attached to the pane's console, Ctrl+C there would otherwise kill this process too.
        SetConsoleCtrlHandler(IgnoreCtrl, true);
        WatchLog(stateFile, "start pid=" + GetCurrentProcessId() + " claude=" + claude);

        long idleSince = 0, lastReport = 0, stateMissingSince = 0;
        var title = new StringBuilder(1024);
        while (WaitForSingleObject(proc, 0) == WAIT_TIMEOUT)
        {
            long now = Now();
            string state = null;
            try { state = File.ReadAllText(stateFile); } catch { }
            if (state == null)
            {
                if (stateMissingSince == 0) stateMissingSince = now;
                else if (now - stateMissingSince > MissingStateMs) break; // SessionEnd removed it.
            }
            else stateMissingSince = 0;

            title.Clear();
            GetConsoleTitleW(title, 1024);
            bool idle = title.Length > 0 && title[0] == IdleGlyph;
            if (!idle) idleSince = 0;
            else if (idleSince == 0) idleSince = now;

            bool working = state != null && state.Contains("\"state\":\"working\"") && !state.Contains("\"reason\":\"background-running\"");
            if (idle && working && now - idleSince >= IdleConfirmMs && now - lastReport >= ReportEveryMs)
            {
                lastReport = now;
                WatchLog(stateFile, "report idle " + (now - idleSince) + "ms: " + Report(nodeExe, glanceMjs, claude, sessionId, idleSince));
            }
            Thread.Sleep(PollMs);
        }
        CloseHandle(proc);
        WatchLog(stateFile, "exit");
        return 0;
    }

    // One line per watcher start, report, error, and exit, beside the state files.
    static void WatchLog(string stateFile, string msg)
    {
        try
        {
            string file = Path.Combine(Path.GetDirectoryName(stateFile), "watch.log");
            var fi = new FileInfo(file);
            if (fi.Exists && fi.Length > 256 * 1024) File.Delete(file);
            File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + Path.GetFileNameWithoutExtension(stateFile).Substring(0, Math.Min(8, Path.GetFileNameWithoutExtension(stateFile).Length)) + " " + msg + Environment.NewLine);
        }
        catch { }
    }

    static string Report(string nodeExe, string glanceMjs, uint claude, string sessionId, long idleSince)
    {
        try
        {
            var psi = new ProcessStartInfo(nodeExe, "\"" + glanceMjs + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
            };
            psi.EnvironmentVariables["GLANCE_CLAUDE_PID"] = claude.ToString();
            using (var p = Process.Start(psi))
            {
                p.StandardInput.Write("{\"hook_event_name\":\"TitleIdle\",\"session_id\":\"" + sessionId + "\",\"idle_since\":" + idleSince + "}");
                p.StandardInput.Close();
                if (!p.WaitForExit(5000)) return "node timed out";
                return "node exit " + p.ExitCode;
            }
        }
        catch (Exception ex) { return "error " + ex.GetType().Name + ": " + ex.Message; }
    }

    static int Main(string[] args)
    {
        uint pid;
        if (args.Length == 1 && args[0] == "--pid")
        {
            uint claude = FindClaudeAncestor();
            Console.Out.Write(claude);
            return claude == 0 ? 3 : 0;
        }
        if (args.Length == 1 && args[0] == "--utc-offset")
        {
            // Node misreads some Windows time zones; .NET reads the real one.
            Console.Out.Write((int)TimeZoneInfo.Local.GetUtcOffset(DateTime.Now).TotalMinutes);
            return 0;
        }
        if (args.Length == 1 && args[0] == "--source-hash")
        {
            // BuildInfo is generated by build.ps1.
            Console.Out.Write(BuildInfo.SourceSha256);
            return 0;
        }
        if (args.Length == 2 && args[0] == "--title" && uint.TryParse(args[1], out pid))
        {
            // Diagnostic: print another Claude pane's title.
            var sb = new StringBuilder(1024);
            FreeConsole();
            if (!AttachConsole(pid)) return 4;
            GetConsoleTitleW(sb, 1024);
            FreeConsole();
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.Write(sb.ToString());
            stdout.Flush();
            return 0;
        }
        if (args.Length == 6 && args[0] == "--watch" && uint.TryParse(args[1], out pid))
            return Watch(pid, args[2], args[3], args[4], args[5]);
        if (args.Length >= 1 && args.Length <= 2 && args[0].Length > 0 && args[0].Length <= 64 && !args[0].StartsWith("--"))
        {
            uint claude = 0;
            if (args.Length == 2 && !uint.TryParse(args[1], out claude)) return 2;
            return Write(args[0], claude);
        }
        return 2;
    }
}
