# ============================================================
#  大肥鱼智能大屏 - 一键构建安装包
#  用法:
#    .\build-installer.ps1                # 用 VERSION 文件里的版本号构建
#    .\build-installer.ps1 -Version 1.1.0 # 升版并构建（自动同步 index.html）
#  产物: 安装包\大肥鱼大屏_安装包_v<版本>.exe
# ============================================================
param(
  [string]$Version = '',
  [switch]$KeepStage
)
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj   = Split-Path -Parent $root
$verFile= Join-Path $root 'VERSION'
$htmlPath = Join-Path $proj 'index.html'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Normalize-Version([string]$v) {
  $v = ($v -replace '^[vV]', '').Trim()
  if ($v -notmatch '^\d+\.\d+(\.\d+)?$') { throw "版本号格式不正确: '$v'（示例 1.0.0）" }
  return $v
}

# ---- 1. 确定版本号，并与 index.html 同步 ----
$html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.Encoding]::UTF8)
if ($html -notmatch "const APP_VERSION='([^']+)'") { throw 'index.html 中找不到 APP_VERSION 常量' }
$appVer = $Matches[1]

if ($Version) {
  $Version = Normalize-Version $Version
  if ($Version -ne $appVer) {
    $html = $html -replace "const APP_VERSION='[^']+'", "const APP_VERSION='$Version'"
    [System.IO.File]::WriteAllText($htmlPath, $html, $utf8NoBom)
    [System.IO.File]::WriteAllText($verFile, $Version + "`r`n", $utf8NoBom)
    Write-Host "[版本] index.html 与 VERSION 已更新为 $Version" -ForegroundColor Yellow
    $appVer = $Version
  }
} else {
  $Version = Normalize-Version (Get-Content $verFile -Raw)
  if ($Version -ne $appVer) {
    throw "版本不一致: index.html=$appVer, VERSION=$Version。请执行 .\build-installer.ps1 -Version $Version 自动同步。"
  }
}
$ver4 = if (($Version -split '\.').Count -ge 4) { $Version } else { "$Version.0" }
Write-Host "[版本] 即将构建 v$Version" -ForegroundColor Cyan

# ---- 2. 收集运行文件到 payload ----
$payload = Join-Path $root 'payload'
if (-not ($KeepStage -and (Test-Path $payload))) {
  if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
  New-Item -ItemType Directory -Path $payload -Force | Out-Null

  $runtimeFiles = @(
    '大肥鱼大屏.exe',
    'index.html',
    'keep_alive.js',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll'
  )
  foreach ($f in $runtimeFiles) {
    $src = Join-Path $proj $f
    if (-not (Test-Path $src)) { throw "缺少运行文件: $f" }
    Copy-Item $src (Join-Path $payload $f) -Force
  }
  foreach ($dir in @('assets', 'mcp-server', 'pc-server')) {
    $src = Join-Path $proj $dir
    if (-not (Test-Path $src)) { throw "缺少目录: $dir" }
    Copy-Item $src (Join-Path $payload $dir) -Recurse -Force
  }

  # 语音引擎（仅脚本 + 预置音色，不含模型/缓存/测试音频）
  $ttsSrc = Join-Path $proj 'tts'
  if (Test-Path $ttsSrc) {
    $ttsDst = Join-Path $payload 'tts'
    New-Item -ItemType Directory -Path $ttsDst -Force | Out-Null
    foreach ($f in @('tts_server.py', 'edge_tts_server.py', 'requirements-edge.txt', 'requirements-chattts.txt', 'install-tts.cmd')) {
      $src = Join-Path $ttsSrc $f
      if (Test-Path $src) { Copy-Item $src (Join-Path $ttsDst $f) -Force }
    }
    $voicesSrc = Join-Path $ttsSrc 'voices'
    if (Test-Path $voicesSrc) {
      $voicesDst = Join-Path $ttsDst 'voices'
      New-Item -ItemType Directory -Path $voicesDst -Force | Out-Null
      Get-ChildItem $voicesSrc -Filter *.txt -File | Copy-Item -Destination $voicesDst -Force
    }
  }

  # 视频/文件服务（18905）：抖音摸鱼 + 大屏的文件浏览/删除
  # 只带脚本与依赖，排除本机登录 profile（.douyin-profile）、运行状态与日志
  $vsSrc = Join-Path $proj 'video-server'
  if (Test-Path $vsSrc) {
    $vsDst = Join-Path $payload 'video-server'
    robocopy $vsSrc $vsDst /E /XD .douyin-profile .git /XF state.json *.log /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "打包 video-server 失败，robocopy 退出码 $LASTEXITCODE" }
  }

  # 使用说明 cmd（完整流程 / 发布介绍），从 安装包 目录取最新一份
  $pkgDir = Join-Path $proj '安装包'
  if (Test-Path $pkgDir) {
    Get-ChildItem $pkgDir -Filter '大肥鱼大屏_*完整流程*.cmd' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
      ForEach-Object { Copy-Item $_.FullName (Join-Path $payload $_.Name) -Force }
    Get-ChildItem $pkgDir -Filter '大肥鱼大屏_*发布介绍*.cmd' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
      ForEach-Object { Copy-Item $_.FullName (Join-Path $payload $_.Name) -Force }
  }

  # QQ 机器人脚本（排除本地 profile、缓存与日志）
  $qqSrc = Join-Path $proj 'qqbot'
  if (Test-Path $qqSrc) {
    $qqDst = Join-Path $payload 'qqbot'
    New-Item -ItemType Directory -Path $qqDst -Force | Out-Null
    $qqFiles = @(
      'config.template.json',
      'install-qqbot.cmd', 'install-qqbot.ps1',
      'start-qqbot.cmd', 'start-qqbot.ps1',
      'discover-openid.cmd',
      'set-whitelist.cmd', 'set-whitelist.ps1',
      'bridge.cmd', 'bridge.vbs'
    )
    foreach ($f in $qqFiles) {
      $src = Join-Path $qqSrc $f
      if (Test-Path $src) { Copy-Item $src (Join-Path $qqDst $f) -Force }
    }
    # 本地控制服务（含 qrcode 依赖）
    $bridgeSrc = Join-Path $qqSrc 'bridge'
    if (Test-Path $bridgeSrc) { Copy-Item $bridgeSrc (Join-Path $qqDst 'bridge') -Recurse -Force }
    # 本地插件（fish-tone / whale / nekowhale），排除源码与依赖
    $pluginsSrc = Join-Path $qqSrc 'plugins'
    if (Test-Path $pluginsSrc) {
      $pluginsDst = Join-Path $qqDst 'plugins'
      robocopy $pluginsSrc $pluginsDst /E /XD node_modules test tests tools docs src .git /XF *.ts tsconfig.json pnpm-lock.yaml /NFL /NDL /NJH /NJS /NP | Out-Null
    }
    # dsh qqbot profile（含本地插件 link 与 cordis 配置；node_modules 由 install-qqbot.ps1 重新 link）
    $dshProfileSrc = Join-Path $qqSrc '.dsh\profiles\qqbot'
    if (Test-Path $dshProfileSrc) {
      $dshProfileDst = Join-Path $qqDst '.dsh\profiles\qqbot'
      New-Item -ItemType Directory -Path $dshProfileDst -Force | Out-Null
      foreach ($f in @('package.json','cordis.patch.yml','cordis.yml','pnpm-lock.yaml','pnpm-workspace.yaml')) {
        $fp = Join-Path $dshProfileSrc $f
        if (Test-Path $fp) { Copy-Item $fp $dshProfileDst -Force }
      }
    }
    # 安装包内使用空白模板，避免把本机的 API Key / 白名单带出去
    $tpl = Join-Path $qqSrc 'config.template.json'
    if (Test-Path $tpl) { Copy-Item $tpl (Join-Path $qqDst 'config.json') -Force }
  }
  $mb = [math]::Round(((Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
  Write-Host "[打包] 已暂存运行文件 ($mb MB)" -ForegroundColor Cyan
}

# ---- 3. 从主程序提取图标 ----
$ico = Join-Path $root 'app.ico'
$noIcon = $false
try {
  Add-Type -AssemblyName System.Drawing
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Join-Path $proj '大肥鱼大屏.exe'))
  if ($icon) {
    $fs = [System.IO.File]::Create($ico)
    $icon.Save($fs); $fs.Close()
    Write-Host "[图标] 已从主程序提取" -ForegroundColor Cyan
  } else { $noIcon = $true }
} catch {
  Write-Warning "图标提取失败，将使用默认图标: $($_.Exception.Message)"
  $noIcon = $true
}

# ---- 4. 调用 Inno Setup 编译 ----
$iscc = Join-Path $root 'tools\InnoSetup\ISCC.exe'
if (-not (Test-Path $iscc)) { throw "未找到 Inno Setup 编译器: $iscc" }
$iss = Join-Path $root 'app.iss'
$isccArgs = @("/DAppVersion=$Version", "/DAppVersion4=$ver4")
if (Test-Path (Join-Path $root 'tools\InnoSetup\Languages\ChineseSimplified.isl')) { $isccArgs += '/DCHINESE=1' }
if ($noIcon) { $isccArgs += '/DNOICON=1' }
$isccArgs += $iss

Write-Host "[编译] 正在生成安装包…" -ForegroundColor Cyan
& $iscc @isccArgs
if ($LASTEXITCODE -ne 0) { throw "安装包编译失败，ISCC 退出码 $LASTEXITCODE" }

$out = Join-Path $proj ("安装包\大肥鱼大屏_安装包_v$Version.exe")
if (-not (Test-Path $out)) { throw "未找到生成的安装包: $out" }
$size = [math]::Round(((Get-Item $out).Length / 1MB), 1)

# ---- 5. 清理暂存目录（保持项目整洁） ----
if (-not $KeepStage) { Remove-Item $payload -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "构建完成: $out ($size MB)" -ForegroundColor Green
