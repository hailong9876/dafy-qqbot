﻿﻿﻿param(
  [switch]$Discover
)
# ============================================================
#  大肥鱼 QQ 机器人启动器（基于官方 @tencent-connect/dsh-qqbot）
#  - 首次启动：终端/浏览器显示二维码，手机 QQ 扫码绑定
#  - 白名单：只回复 config.json 中 c2cAllow / groupAllow 里的 OpenID
#  - -Discover：临时开放所有人（用于 /bot-me 获取 OpenID），记得改回
# ============================================================
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root 'config.json'
$patchDir = Join-Path $root 'patch'
New-Item -ItemType Directory -Path $patchDir -Force | Out-Null

if (-not (Test-Path $cfgPath)) { throw "缺少配置文件：$cfgPath" }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

# npm 全局目录（pnpm 需要）
$env:PATH = "$env:APPDATA\npm;$env:PATH"
# 所有 profile / 凭据都保存在项目内
$env:DSH_HOME = Join-Path $root '.dsh'
# 二维码默认同时拉起系统浏览器；桥接服务会设为 0，改在程序内显示
if (-not $env:QQBOT_BIND_OPEN_BROWSER) { $env:QQBOT_BIND_OPEN_BROWSER = '1' }

# FFmpeg：winget 装的默认不在 PATH，递归找 bin\ffmpeg.exe 后注入
if (-not $env:FFMPEG_PATH) {
  $wingetBase = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $wingetBase) {
    $hit = Get-ChildItem -Path $wingetBase -Filter 'ffmpeg.exe' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -like '*\bin' -and $_.FullName -like '*Gyan.FFmpeg*' } |
      Select-Object -First 1
    if ($hit) {
      $env:PATH = "$($hit.DirectoryName);$env:PATH"
      $env:FFMPEG_PATH = $hit.FullName
    }
  }
}

function ListYaml([string]$name, $items, [string]$indent) {
  if (-not $items -or @($items).Count -eq 0) { return "$indent$name`: []" }
  $s = "$indent$name`:"
  foreach ($i in @($items)) { $s += "`n$indent  - $i" }
  return $s
}

# 读取已绑定凭据（profile patch），避免 overlay 覆盖配置导致重复扫码
$appId = ''
$appSecret = ''
$profilePatch = Join-Path $env:DSH_HOME 'profiles\qqbot\cordis.patch.yml'
if (Test-Path $profilePatch) {
  $pt = Get-Content $profilePatch -Raw -Encoding UTF8
  $m = [regex]::Match($pt, 'appId:\s*"?([^"\r\n]+)"?')
  if ($m.Success) { $appId = $m.Groups[1].Value.Trim() }
  $m = [regex]::Match($pt, 'appSecret:\s*"?([^"\r\n]+)"?')
  if ($m.Success) { $appSecret = $m.Groups[1].Value.Trim() }
}

# ---- 1. 生成白名单补丁 ----
$c2c = @($cfg.c2cAllow | Where-Object { $_ })
$grp = @($cfg.groupAllow | Where-Object { $_ })
$mode = if ($Discover) { 'open' } else { 'allowlist' }
$gmode = if ($Discover -or $cfg.groupOpen) { 'open' } else { 'allowlist' }
$rm = if ($cfg.requireMention -eq $false) { 'false' } else { 'true' }
$persona = [string]$cfg.persona

# 读取大肥鱼写入的共享记忆快照（Conversation_Records/dafy_memory_*.json）
$memFacts = @()
$memDir = Join-Path (Split-Path (Split-Path (Split-Path $root))) 'Conversation_Records'
if (Test-Path $memDir) {
  $mf = Get-ChildItem $memDir -Filter 'dafy_memory*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($mf) {
    try {
      $mo = Get-Content $mf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($mo.facts) {
        $memAll = @($mo.facts | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
        # 视频记忆最多 12 条，用户本人相关记忆优先，总量上限 60（与 bridge.js 保持一致）
        $memPersonal = @($memAll | Where-Object { $_ -notmatch '^【刷视频】' } | Select-Object -First 48)
        $memVideo = @($memAll | Where-Object { $_ -match '^【刷视频】' } | Select-Object -First 12)
        $memFacts = @($memPersonal + $memVideo)
      }
    } catch { }
  }
}
$promptLines = @()
if ($persona.Trim()) { $promptLines += $persona.Trim() }
if ($memFacts.Count) {
  $promptLines += ''
  $promptLines += '【关于用户的记忆】'
  foreach ($m in $memFacts) { $promptLines += ('- ' + $m) }
}
$promptLines += ''
$promptLines += '【媒体理解】消息里出现 "Image: 路径" 时，必须先调用 qqbot_look_image 工具真正看过图片再回答；出现 "Video: 路径" 时，必须先调用 qqbot_analyze_video 工具分析视频再回答。不要凭文件名猜测内容。'

$wl = @(
  '- id: im-qqbot'
  '  config:'
)
if ($appId -and $appSecret) {
  $wl += "    appId: `"$appId`""
  $wl += "    appSecret: `"$appSecret`""
}
$wl += "    requireMention: $rm"
if ($promptLines.Count) {
  $wl += '    directPrompt: |'
  foreach ($l in $promptLines) { $wl += ('      ' + $l) }
  $wl += '    groupPrompt: |'
  foreach ($l in $promptLines) { $wl += ('      ' + $l) }
}
$wl += '    access:'
$wl += "      c2cMode: $mode"
$wl += (ListYaml 'c2cAllow' $c2c '      ')
$wl += "      groupMode: $gmode"
$wl += (ListYaml 'groupAllow' $grp '      ')
# 富媒体：图片/视频自动下载到本地 ~/.dsh-qqbot/media
$wl += '    media:'
$wl += '      enabled: true'
$wl += '      maxMB: 200'
$wl += '      ttlHours: 24'
# 视觉理解：provider/model 留空时内置 qqbot_describe_image 不注册（改用插件 qqbot_look_image）
$wl += '    vision:'
$wl += '      enabled: true'
$wl += '      provider: ""'
$wl += '      model: ""'
$wl += '      defaultPrompt: "请详细描述这张图片里有什么。"'

$wlPath = Join-Path $patchDir 'whitelist.patch.yml'
[System.IO.File]::WriteAllText($wlPath, ($wl -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))

# ---- 2. 生成 LLM 补丁 ----
$llmPath = Join-Path $patchDir 'llm.patch.yml'
$llmMode = 'none'
if ($cfg.llmMode -eq 'ollama') {
  # 本机 Ollama（OpenAI 兼容接口），不依赖任何网关
  $base = if ($cfg.ollamaBase) { [string]$cfg.ollamaBase } else { 'http://127.0.0.1:11434/v1' }
  # 11435 是 bridge 内置的转发代理（关掉 R1 思考）；单独运行本脚本时若代理不在，直接连 Ollama
  if ($base -match '11435') {
    try {
      $tc = New-Object System.Net.Sockets.TcpClient
      $tc.Connect('127.0.0.1', 11435)
      $tc.Close()
    } catch { $base = 'http://127.0.0.1:11434/v1' }
  }
  $ollModel = if ($cfg.ollamaModel) { [string]$cfg.ollamaModel } else { 'deepseek-r1:14b' }
  $env:DAFY_OLLAMA_KEY = 'ollama'
  $env:DSH_VISION_BASE_URL = $base
  $env:DSH_VISION_API_KEY = 'ollama'
  $env:DSH_VISION_MODEL = $ollModel
  $llm = @(
    '- id: llm-pi-ai'
    '  config:'
    '    providers:'
    '      ollama:'
    '        displayName: 本机 DeepSeek'
    '        apiKeyEnv: DAFY_OLLAMA_KEY'
    '        api: openai-completions'
    "        baseURL: $base"
    '        models:'
    "          - id: `"$ollModel`""
    "            name: `"$ollModel`""
    '            contextWindow: 4096'
    '            maxTokens: 400'
    '- id: agent-default-model'
    '  config:'
    '    provider: ollama'
    "    model: `"$ollModel`""
  ) -join "`n"
  [System.IO.File]::WriteAllText($llmPath, $llm + "`n", (New-Object System.Text.UTF8Encoding($false)))
  $llmMode = "本机 Ollama（$base / $ollModel）"
}
elseif ($cfg.deepseekApiKey) {
  $env:DEEPSEEK_API_KEY = [string]$cfg.deepseekApiKey
  $base = if ($cfg.deepseekBaseUrl) { [string]$cfg.deepseekBaseUrl } else { 'https://api.deepseek.com' }
  $dsModel = if ($cfg.deepseekModel) { [string]$cfg.deepseekModel } else { 'deepseek-chat' }
  $env:DSH_VISION_BASE_URL = $base
  $env:DSH_VISION_API_KEY = [string]$cfg.deepseekApiKey
  $env:DSH_VISION_MODEL = if ($cfg.visionModel) { [string]$cfg.visionModel } else { 'mimo-v2.6-flash-free' }
  $llm = @(
    '- id: llm-deepseek-account'
    '  disabled: true'
    '- id: llm-deepseek'
    '  config:'
    '    apiKeyEnv: DEEPSEEK_API_KEY'
    "    baseURL: $base"
    '- id: web-search-deepseek'
    '  disabled: true'
    '- id: web-deepseek-api'
    '  disabled: true'
    '- id: agent-default-model'
    '  config:'
    '    provider: deepseek-official'
    "    model: $dsModel"
  ) -join "`n"
  [System.IO.File]::WriteAllText($llmPath, $llm + "`n", (New-Object System.Text.UTF8Encoding($false)))
  $llmMode = "DeepSeek 官方 API（$base）"
}
elseif ($cfg.useLocalGateway) {
  $env:DAFY_GW_KEY = [string]$cfg.gatewayKey
  $model = [string]$cfg.gatewayModel
  $llm = @(
    '- id: llm-pi-ai'
    '  config:'
    '    providers:'
    '      dafy:'
    '        displayName: 大肥鱼本地网关'
    '        apiKeyEnv: DAFY_GW_KEY'
    '        api: openai-completions'
    "        baseURL: $([string]$cfg.gatewayBase)"
    '        models:'
    "          - id: $model"
    "            name: $model"
    '            contextWindow: 32768'
    '            maxTokens: 4096'
    '- id: agent-default-model'
    '  config:'
    '    provider: dafy'
    "    model: $model"
  ) -join "`n"
  [System.IO.File]::WriteAllText($llmPath, $llm + "`n", (New-Object System.Text.UTF8Encoding($false)))
  $llmMode = "本地网关（$([string]$cfg.gatewayBase) / $model）"
}
else {
  if (Test-Path $llmPath) { Remove-Item $llmPath -Force }
}

# ---- 3. 启动提示 ----
Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  大肥鱼 QQ 机器人' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ("  LLM:   " + $llmMode)
Write-Host ("  私聊白名单: " + $(if ($c2c.Count) { $c2c.Count.ToString() + ' 个' } else { '空（不回复私聊）' }))
Write-Host ("  群聊白名单: " + $(if ($grp.Count) { $grp.Count.ToString() + ' 个' } else { '空（不回复群聊）' }))
if ($Discover) {
  Write-Host '  调试模式: 已临时开放所有人（用于 /bot-me 获取 OpenID）' -ForegroundColor Yellow
}
if ($llmMode -eq 'none') {
  Write-Host '  警告: 未配置 LLM，扫码绑定可用，但机器人不会回复' -ForegroundColor Yellow
  Write-Host '        请在 config.json 填 deepseekApiKey，或开启 useLocalGateway' -ForegroundColor Yellow
}
if ($llmMode -like '本地网关*') {
  $gwOk = $false
  try {
    $u = ([string]$cfg.gatewayBase).TrimEnd('/') + '/models'
    $r = Invoke-WebRequest -Uri $u -Headers @{ Authorization = ('Bearer ' + [string]$cfg.gatewayKey) } -TimeoutSec 4 -UseBasicParsing
    $gwOk = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch { $gwOk = $false }
  if (-not $gwOk) {
    Write-Host '  警告: 本地网关未连通，机器人暂时不会回复' -ForegroundColor Yellow
    Write-Host '        可启动大肥鱼网关，或在 config.json 填 deepseekApiKey' -ForegroundColor Yellow
  }
}
Write-Host ''
Write-Host '  首次启动会显示二维码：用手机 QQ 扫码绑定' -ForegroundColor Green
Write-Host '  扫码成功后凭据自动保存，下次无需再扫' -ForegroundColor Green
Write-Host '  获取 OpenID：在 QQ 里给机器人发送 /bot-me' -ForegroundColor Green
Write-Host '  关闭窗口即可停止机器人' -ForegroundColor DarkGray
Write-Host ''

# ---- 4. 启动 dsh profile ----
$npxArgs = @('--yes', '@deepseek-ai/dsh@0.2.1-rc.5', '--profile', 'qqbot', '--patch', $wlPath)
if (Test-Path $llmPath) { $npxArgs += @('--patch', $llmPath) }
& npx @npxArgs 2>&1 | Tee-Object -FilePath (Join-Path $root 'bot.log')
