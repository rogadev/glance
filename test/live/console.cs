// console.exe: drives another process's console without taking focus, for the
// live harness (run.mjs). Built on the fly by run.mjs; not committed as a binary.
//   console.exe <pid> send <text>          Type text; {ENTER} {ESC} {TAB} {UP} {DOWN} are keys.
//   console.exe <pid> screen <out-file>    Write the visible screen text to a file.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

static class Con
{
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);

    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public short L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct CSBI { public COORD Size, Cursor; public ushort Attr; public RECT Window; public COORD Max; }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int bKeyDown;
        [FieldOffset(8)] public ushort wRepeatCount;
        [FieldOffset(10)] public ushort wVirtualKeyCode;
        [FieldOffset(12)] public ushort wVirtualScanCode;
        [FieldOffset(14)] public char UnicodeChar;
        [FieldOffset(16)] public uint dwControlKeyState;
    }

    static void Key(List<INPUT_RECORD> recs, ushort vk, char ch)
    {
        foreach (int down in new[] { 1, 0 })
            recs.Add(new INPUT_RECORD { EventType = 1, bKeyDown = down, wRepeatCount = 1, wVirtualKeyCode = vk, UnicodeChar = ch });
    }

    static int Main(string[] args)
    {
        uint pid;
        if (args.Length < 2 || !uint.TryParse(args[0], out pid)) return 2;
        FreeConsole();
        if (!AttachConsole(pid)) { Console.Error.WriteLine("attach " + Marshal.GetLastWin32Error()); return 4; }
        const uint RW = 0xC0000000, SHARE = 3, OPEN = 3;
        if (args[1] == "send" && args.Length == 3)
        {
            IntPtr h = CreateFile("CONIN$", RW, SHARE, IntPtr.Zero, OPEN, 0, IntPtr.Zero);
            var recs = new List<INPUT_RECORD>();
            string s = args[2];
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] == '{')
                {
                    int end = s.IndexOf('}', i);
                    string name = s.Substring(i + 1, end - i - 1);
                    if (name == "ENTER") Key(recs, 0x0D, '\r');
                    else if (name == "ESC") Key(recs, 0x1B, '\x1b');
                    else if (name == "TAB") Key(recs, 0x09, '\t');
                    else if (name == "DOWN") Key(recs, 0x28, (char)0);
                    else if (name == "UP") Key(recs, 0x26, (char)0);
                    else return 2;
                    i = end;
                    continue;
                }
                Key(recs, 0, s[i]);
            }
            uint n;
            if (!WriteConsoleInputW(h, recs.ToArray(), (uint)recs.Count, out n)) return 6;
            return 0;
        }
        if (args[1] == "screen")
        {
            IntPtr h = CreateFile("CONOUT$", RW, SHARE, IntPtr.Zero, OPEN, 0, IntPtr.Zero);
            CSBI info;
            if (!GetConsoleScreenBufferInfo(h, out info)) return 5;
            var sb = new StringBuilder();
            for (short y = info.Window.T; y <= info.Window.B; y++)
            {
                var line = new StringBuilder(info.Size.X);
                uint read;
                ReadConsoleOutputCharacterW(h, line, (uint)info.Size.X, new COORD { X = 0, Y = y }, out read);
                sb.AppendLine(line.ToString(0, (int)read).TrimEnd());
            }
            // To a file: this process gave up its own console (and stdout) to attach.
            if (args.Length < 3) return 2;
            System.IO.File.WriteAllText(args[2], sb.ToString());
            return 0;
        }
        return 2;
    }
}
