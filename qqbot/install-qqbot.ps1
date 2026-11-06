# ============================================================
#  安装 / 更新官方 QQ 插件到项目本地 profile
#  仅在首次部署或升级插件时运行；日常启动用 start-qqbot.cmd
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PATH = "$env:APPDATA\npm;$env:PATH"
$env:DSH_HOME = Join-Path $root '.dsh'

Write-Host '正在安装 / 更新 @tencent-connect/dsh-qqbot …' -ForegroundColor Cyan
Write-Host ('DSH_HOME = ' + $env:DSH_HOME)
& npx --yes '@deepseek-ai/dsh@0.2.1-rc.5' plugin --profile qqbot add '@tencent-connect/dsh-qqbot@0.5.5'
if ($LASTEXITCODE -ne 0) { throw "安装失败，退出码 $LASTEXITCODE" }

Write-Host '正在 link 本地插件（fish-tone / whale / nekowhale）…' -ForegroundColor Cyan
$profileDir = Join-Path $env:DSH_HOME 'profiles\qqbot'
Push-Location $profileDir
try {
  & npx --yes pnpm@9 install --no-optional --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败，退出码 $LASTEXITCODE" }
} finally {
  Pop-Location
}
Write-Host '安装完成。' -ForegroundColor Green
