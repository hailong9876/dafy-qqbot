param([string]$Action = '', [string]$Arg = '')
# 大肥鱼 · 本机能力底层脚本（截屏 / OCR / 键鼠 / 窗口）
# 由 server.js 以 powershell -File native.ps1 -Action <动作> -Arg <base64(JSON)> 调用，
# 结果统一输出一行 JSON 到 stdout。
$ErrorActionPreference = 'Stop'
# 统一用 UTF-8 输出，避免中文经 PowerShell stdout 变成乱码
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int L, T, R, B; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  // 逐字符发送 Unicode，中文也能直接输入（不占用剪贴板）
  public static void TypeText(string text) {
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { KeyTap(0x0D); continue; }
      INPUT[] d = new INPUT[1];
      d[0].type = 1; d[0].u.ki.wScan = (ushort)ch; d[0].u.ki.dwFlags = 0x0004;
      INPUT[] u = new INPUT[1];
      u[0].type = 1; u[0].u.ki.wScan = (ushort)ch; u[0].u.ki.dwFlags = 0x0004 | 0x0002;
      SendInput(1, d, Marshal.SizeOf(typeof(INPUT)));
      SendInput(1, u, Marshal.SizeOf(typeof(INPUT)));
    }
  }
  public static void KeyTap(int vk) {
    keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event((byte)vk, 0, 2, UIntPtr.Zero);
  }
  public static void KeyDown(int vk) { keybd_event((byte)vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(int vk) { keybd_event((byte)vk, 0, 2, UIntPtr.Zero); }
}
'@
try { Add-Type -TypeDefinition $cs -Language CSharp } catch { }

function Out-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 6 -Compress))
}

$p = $null
if ($Arg) {
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Arg)) | ConvertFrom-Json
}

# 让本进程按物理像素工作，保证截图坐标 = 鼠标坐标
try { [W]::SetProcessDPIAware() | Out-Null } catch { }

$VK = @{
  'ctrl'=0x11; 'control'=0x11; 'alt'=0x12; 'shift'=0x10; 'win'=0x5B
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B
  'space'=0x20; 'backspace'=0x08; 'delete'=0x2E; 'del'=0x2E; 'insert'=0x2D
  'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27
  'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22
  'capslock'=0x14; 'printscreen'=0x2C
}
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }
foreach ($ch in [char[]]'abcdefghijklmnopqrstuvwxyz') { $VK[[string]$ch] = [int][char]([string]$ch).ToUpper() }
foreach ($ch in [char[]]'0123456789') { $VK[[string]$ch] = [int][char]$ch }

function Get-Vk($name) {
  $k = ([string]$name).Trim().ToLower()
  if ($VK.ContainsKey($k)) { return [int]$VK[$k] }
  if ($k.Length -eq 1) { return [int][char]$k.ToUpper() }
  throw "不认识的按键: $name"
}

try {
  switch ($Action) {

    'capture' {
      $out = [string]$p.path
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap([int]$vs.Width, [int]$vs.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
      $g.Dispose()
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      Out-Json @{ ok = $true; path = $out; width = [int]$vs.Width; height = [int]$vs.Height; left = [int]$vs.Left; top = [int]$vs.Top }
    }

    'ocr' {
      # Windows 自带 OCR（Windows.Media.Ocr），不联网、不装第三方库
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
      })[0]
      function Await($op, $type) {
        $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
        $t.Wait(20000) | Out-Null
        $t.Result
      }
      [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
      [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
      [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if (-not $engine) {
        foreach ($lang in @('zh-Hans-CN', 'zh-CN', 'en-US')) {
          $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $lang))
          if ($engine) { break }
        }
      }
      if (-not $engine) { throw '系统未安装可用的 OCR 语言包' }

      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync([string]$p.path)) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $sbmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($engine.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult])
      $stream.Dispose()

      $items = New-Object System.Collections.ArrayList
      foreach ($line in $res.Lines) {
        foreach ($w in $line.Words) {
          [void]$items.Add(@{
            t = $w.Text
            x = [int]$w.BoundingRect.X
            y = [int]$w.BoundingRect.Y
            w = [int]$w.BoundingRect.Width
            h = [int]$w.BoundingRect.Height
          })
        }
      }
      Out-Json @{ ok = $true; text = $res.Text; words = @($items) }
    }

    'windows' {
      $list = New-Object System.Collections.ArrayList
      $cb = [W+EnumProc] {
        param($h, $l)
        if ([W]::IsWindowVisible($h)) {
          $sb = New-Object System.Text.StringBuilder 512
          [void][W]::GetWindowTextW($h, $sb, 512)
          $title = $sb.ToString()
          if ($title -and $title.Trim().Length -gt 0) {
            $r = New-Object W+RECT
            [void][W]::GetWindowRect($h, [ref]$r)
            $w = $r.R - $r.L; $hh = $r.B - $r.T
            if ($w -gt 80 -and $hh -gt 80) {
              $pidv = 0
              [void][W]::GetWindowThreadProcessId($h, [ref]$pidv)
              $pname = ''
              try { $pname = (Get-Process -Id $pidv -ErrorAction Stop).ProcessName } catch { }
              [void]$list.Add(@{
                hwnd = [int64]$h; title = $title; pid = [int]$pidv; proc = $pname
                x = $r.L; y = $r.T; w = $w; h = $hh
              })
            }
          }
        }
        return $true
      }
      [void][W]::EnumWindows($cb, [IntPtr]::Zero)
      $fg = [int64][W]::GetForegroundWindow()
      Out-Json @{ ok = $true; foreground = $fg; windows = @($list) }
    }

    'focus' {
      $h = [IntPtr][int64]$p.hwnd
      [void][W]::ShowWindow($h, 9)
      # 前台锁：先按一下 Alt 再 SetForegroundWindow，否则系统会拒绝切换
      [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [void][W]::SetForegroundWindow($h)
      [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 250
      $fg = [W]::GetForegroundWindow()
      if ($fg -ne $h) {
        [W]::SwitchToThisWindow($h, $true)
        Start-Sleep -Milliseconds 250
        $fg = [W]::GetForegroundWindow()
      }
      Out-Json @{ ok = ($fg -eq $h); foreground = [int64]$fg }
    }

    'mouse' {
      $act = ([string]$p.action).ToLower()
      $x = [int]$p.x
      $y = [int]$p.y
      switch ($act) {
        'move' { [void][W]::SetCursorPos($x, $y) }
        default {
          [void][W]::SetCursorPos($x, $y)
          Start-Sleep -Milliseconds 60
          if ($act -eq 'right') {
            [W]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
            [W]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
          } elseif ($act -eq 'wheel') {
            $delta = [int]$p.delta
            [W]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero)
          } elseif ($act -eq 'double') {
            for ($i = 0; $i -lt 2; $i++) {
              [W]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
              [W]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
              Start-Sleep -Milliseconds 70
            }
          } else {
            [W]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [W]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
          }
        }
      }
      Out-Json @{ ok = $true; action = $act; x = $x; y = $y }
    }

    'type' {
      $txt = [string]$p.text
      [W]::TypeText($txt)
      Out-Json @{ ok = $true; length = $txt.Length }
    }

    'key' {
      $keys = [string]$p.keys
      $parts = $keys -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
      $vks = @()
      foreach ($k in $parts) { $vks += Get-Vk $k }
      foreach ($vk in $vks) { [W]::KeyDown($vk); Start-Sleep -Milliseconds 30 }
      [array]::Reverse($vks)
      foreach ($vk in $vks) { [W]::KeyUp($vk); Start-Sleep -Milliseconds 30 }
      Out-Json @{ ok = $true; keys = $parts }
    }

    'apps' {
      # 列出桌面（当前用户 + 公共桌面）上的快捷方式
      $dirs = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory')
      )
      $shell = New-Object -ComObject WScript.Shell
      $list = @()
      $seen = @{}
      foreach ($d in $dirs) {
        if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
          $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
          if ($seen.ContainsKey($name)) { continue }
          $seen[$name] = $true
          $target = ''
          try { $target = [string]$shell.CreateShortcut($f.FullName).TargetPath } catch {}
          $list += @{ name = $name; path = $f.FullName; target = $target }
        }
      }
      Out-Json @{ ok = $true; count = $list.Count; apps = $list }
    }

    'launch' {
      $want = ([string]$p.name).Trim()
      if (-not $want) { Out-Json @{ ok = $false; reason = '缺少程序名' }; break }
      $dirs = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory')
      )
      $exact = @()
      $fuzzy = @()
      foreach ($d in $dirs) {
        if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
          $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
          if ($name -eq $want) { $exact += $f }
          elseif ($name -like "*$want*") { $fuzzy += $f }
        }
      }
      $hits = if ($exact.Count -gt 0) { $exact } else { $fuzzy }
      if ($hits.Count -eq 0) { Out-Json @{ ok = $false; reason = "桌面上没找到: $want" }; break }
      if ($hits.Count -gt 1) {
        Out-Json @{ ok = $false; reason = '匹配到多个，请说得更准确'; candidates = @($hits | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) }) }
        break
      }
      Start-Process -FilePath $hits[0].FullName
      Out-Json @{ ok = $true; launched = [IO.Path]::GetFileNameWithoutExtension($hits[0].Name); path = $hits[0].FullName }
    }

    'open' {
      # 通用打开：路径 / 常用目录别名 / 系统程序 / 桌面与开始菜单快捷方式
      $t = (([string]$p.target).Trim()).Trim('"')
      if (-not $t) { Out-Json @{ ok = $false; reason = '缺少要打开的目标' }; break }

      # 1) 已是存在的路径
      $expand = [Environment]::ExpandEnvironmentVariables($t)
      if (Test-Path -LiteralPath $expand) {
        Start-Process -FilePath $expand
        $isDir = (Get-Item -LiteralPath $expand).PSIsContainer
        Out-Json @{ ok = $true; opened = $expand; kind = $(if ($isDir) { 'folder' } else { 'file' }) }
        break
      }

      # 2) 常用目录别名
      $folders = @{
        '桌面' = 'Desktop'; '文档' = 'MyDocuments'; '我的文档' = 'MyDocuments'
        '图片' = 'MyPictures'; '音乐' = 'MyMusic'; '视频' = 'MyVideos'
        '下载' = 'Downloads'; '用户' = 'UserProfile'; '用户目录' = 'UserProfile'
      }
      if ($folders.ContainsKey($t)) {
        $key = $folders[$t]
        $fp = ''
        if ($key -eq 'Downloads') {
          # 下载目录常被重定向，优先读注册表
          try {
            $reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
            $fp = [Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -Path $reg -ErrorAction Stop).'{374DE290-123F-4565-9164-39C4925E467B}')
          } catch {}
          if (-not $fp -or -not (Test-Path -LiteralPath $fp)) { $fp = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads' }
        } else {
          $fp = [Environment]::GetFolderPath($key)
        }
        if ($fp -and (Test-Path -LiteralPath $fp)) {
          Start-Process -FilePath $fp
          Out-Json @{ ok = $true; opened = $fp; kind = 'folder' }
          break
        }
      }

      # 3) 系统自带程序别名
      $sysapps = @{
        '记事本' = 'notepad'; '计算器' = 'calc'; '画图' = 'mspaint'; '任务管理器' = 'taskmgr'
        '控制面板' = 'control'; '命令行' = 'cmd'; '资源管理器' = 'explorer'; '设置' = 'ms-settings:'
      }
      if ($sysapps.ContainsKey($t)) {
        Start-Process -FilePath $sysapps[$t]
        Out-Json @{ ok = $true; opened = $t; kind = 'app' }
        break
      }

      # 4) 桌面 + 开始菜单快捷方式（精确优先，其次模糊）
      $dirs = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Programs'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
      )
      $exact = @()
      $fuzzy = @()
      foreach ($d in $dirs) {
        if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -Recurse -Depth 3 -ErrorAction SilentlyContinue)) {
          $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
          if ($name -eq $t) { $exact += $f }
          elseif ($name -like "*$t*") { $fuzzy += $f }
        }
      }
      $hits = if ($exact.Count -gt 0) { $exact } else { $fuzzy }
      if ($hits.Count -eq 1) {
        Start-Process -FilePath $hits[0].FullName
        Out-Json @{ ok = $true; opened = [IO.Path]::GetFileNameWithoutExtension($hits[0].Name); kind = 'app' }
        break
      }
      if ($hits.Count -gt 1) {
        Out-Json @{ ok = $false; reason = '匹配到多个，请说得更准确'; candidates = @($hits | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) }) }
        break
      }

      # 5) 像路径但不存在
      if ($t -match '^[A-Za-z]:' -or $t -match '[\\/]') {
        Out-Json @{ ok = $false; reason = "路径不存在: $t" }
        break
      }

      # 6) 最后交给系统 PATH 解析
      try {
        Start-Process -FilePath $t
        Out-Json @{ ok = $true; opened = $t; kind = 'app' }
      } catch {
        Out-Json @{ ok = $false; reason = "找不到程序或路径: $t" }
      }
    }

    default { Out-Json @{ ok = $false; reason = "未知动作: $Action" } }
  }
} catch {
  Out-Json @{ ok = $false; reason = $_.Exception.Message }
}
