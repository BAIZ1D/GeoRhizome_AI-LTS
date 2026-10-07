import os

filepath = 'installers/install.ps1'
with open(filepath, 'r', encoding='utf-8-sig') as f:
    content = f.read()

font_block = '''$Code = @"
using System;
using System.Runtime.InteropServices;
public class ConsoleFont {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CONSOLE_FONT_INFO_EX {
        public uint cbSize;
        public uint nFont;
        public short dwFontSizeX;
        public short dwFontSizeY;
        public int FontFamily;
        public int FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FaceName;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetCurrentConsoleFontEx(IntPtr hConsoleOutput, bool bMaximumWindow, ref CONSOLE_FONT_INFO_EX lpConsoleCurrentFontEx);
    public static void SetFont(string fontName) {
        CONSOLE_FONT_INFO_EX info = new CONSOLE_FONT_INFO_EX();
        info.cbSize = (uint)Marshal.SizeOf(info);
        info.FaceName = fontName;
        SetCurrentConsoleFontEx(GetStdHandle(-11), false, ref info);
    }
}
"@
try {
    Add-Type -TypeDefinition $Code -ErrorAction SilentlyContinue
    [ConsoleFont]::SetFont("MS Gothic")
} catch {}
'''

lines = content.split('\n')
new_content = lines[0] + '\n' + font_block + '\n'.join(lines[1:])

with open(filepath, 'w', encoding='utf-8-sig') as f:
    f.write(new_content)
