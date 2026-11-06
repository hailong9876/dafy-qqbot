param(
  [string]$C2C = '',
  [string]$Groups = ''
)
# ============================================================
#  设置 QQ 机器人白名单（只回复名单内的 OpenID）
#  用法：
#    .\set-whitelist.ps1 -C2C "id1,id2" -Groups "g1,g2"
#    或直接双击 set-whitelist.cmd 按提示输入
#  OpenID 获取：在 QQ 里给机器人发送 /bot-me
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) { throw "缺少配置文件：$cfgPath" }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

function SplitList([string]$s) {
  @($s -split '[,，;；\s]+' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
}

function ShowList($items) {
  if (-not $items -or @($items).Count -eq 0) { return '（空）' }
  return (@($items) -join ', ')
}

if (-not $C2C -and -not $Groups) {
  Write-Host ''
  Write-Host '当前白名单：' -ForegroundColor Cyan
  Write-Host ('  私聊: ' + (ShowList $cfg.c2cAllow))
  Write-Host ('  群聊: ' + (ShowList $cfg.groupAllow))
  Write-Host ''
  Write-Host '提示：在 QQ 里给机器人发送 /bot-me 可查看自己的 OpenID 和群 OpenID' -ForegroundColor Green
  Write-Host '      留空表示该类消息不回复' -ForegroundColor DarkGray
  Write-Host ''
  $C2C = Read-Host '私聊 OpenID（逗号分隔）'
  $Groups = Read-Host '群聊 OpenID（逗号分隔）'
}

$cfg.c2cAllow = SplitList $C2C
$cfg.groupAllow = SplitList $Groups
$json = $cfg | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($cfgPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '白名单已保存：' -ForegroundColor Green
Write-Host ('  私聊: ' + (ShowList $cfg.c2cAllow))
Write-Host ('  群聊: ' + (ShowList $cfg.groupAllow))
Write-Host '重启 QQ 机器人后生效（关闭窗口，再运行 start-qqbot.cmd）' -ForegroundColor Yellow
