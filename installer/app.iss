; ============================================================
;  大肥鱼智能大屏 - Inno Setup 6 安装包脚本
;  版本号与图标由 ..\build-installer.ps1 自动注入
;  手动编译: ISCC.exe /DAppVersion=1.0.0 /DAppVersion4=1.0.0.0 app.iss
; ============================================================

#define AppName "大肥鱼智能大屏"
#define AppShortName "大肥鱼大屏"
#define AppPublisher "大肥鱼"
#define AppExeName "大肥鱼大屏.exe"
#define AppId "{{8F3C2A71-5B4D-4E9A-9C62-7A1D3F5B8E20}"

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef AppVersion4
  #define AppVersion4 "1.0.0.0"
#endif

[Setup]
; AppId 固定不变，后续版本升级会识别为同一程序并原地更新
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppShortName}
DefaultGroupName={#AppName}
; 允许用户自选安装目录
DisableDirPage=no
DisableProgramGroupPage=yes
; 默认免管理员安装到当前用户目录，也允许用户手动切换为“为所有用户安装”
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\安装包
OutputBaseFilename=大肥鱼大屏_安装包_v{#AppVersion}
#ifdef NOICON
#else
SetupIconFile=app.ico
#endif
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
AllowNoIcons=yes
; 覆盖安装前尝试关闭正在运行的旧版本
CloseApplications=yes
RestartApplications=no
; 升级时记住上次安装目录与快捷方式选择
UsePreviousAppDir=yes
UsePreviousTasks=yes
; 安装包自身的版本信息（右键属性可见）
VersionInfoVersion={#AppVersion4}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion4}
VersionInfoDescription={#AppName} 安装程序
VersionInfoCompany={#AppPublisher}

[Languages]
#ifdef CHINESE
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#else
Name: "en"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
; 桌面快捷方式：默认勾选，升级时沿用上次选择
Name: "desktopicon"; Description: "创建桌面快捷方式(&D)"; GroupDescription: "附加任务:"; Flags: checkedonce
; 开机自动启动 QQ 机器人控制服务
Name: "qqbotautostart"; Description: "开机自动启动 QQ 机器人控制服务"; GroupDescription: "QQ 机器人:"; Flags: checkedonce

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "DafeiYuQQBridge"; ValueData: """{app}\qqbot\bridge.vbs"""; Flags: uninsdeletevalue; Tasks: qqbotautostart

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "立即启动 {#AppName}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\qqbot\bridge.cmd"; Description: "启动 QQ 机器人控制服务"; Flags: nowait postinstall skipifsilent

[Code]
{ WebView2 运行时检测：缺失时提示但不阻止安装 }
function HasWebView2(): Boolean;
var v: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not HasWebView2() then
    MsgBox('未检测到 Microsoft Edge WebView2 运行时。' + #13#10 +
           '大肥鱼大屏需要它才能正常显示界面，建议先安装后继续。' + #13#10 +
           '可从微软官网下载 WebView2 Evergreen Runtime。', mbInformation, MB_OK);
end;
