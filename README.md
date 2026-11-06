# 大肥鱼 🐟

一个跑在 Windows 本机的「桌宠 + QQ 机器人 + 大屏控制台」一体项目。

大屏是一个 WebView2 桌面应用，里面集成对话、语音、QQ 机器人控制、自进化实验面板；QQ 机器人基于 DeepSeek Harness（dsh）插件，支持主动发言、定时消息和富媒体理解。

---

## 功能

### 大屏（`index.html` + `大肥鱼大屏.exe`）

- **对话舱**：接本地模型网关，支持图片/文件附件、工具调用、对话历史与记忆提取
- **桌宠**：可摸头、有情绪表情，支持缩放与开关
- **语音合成**：Edge-TTS（秒级）与 ChatTTS（离线）双引擎，回复自动朗读
- **QQ 机器人控制台**：扫码绑定、白名单、启停、二维码
- **主动发言**：让机器人自己判断要不要找你说话
- **Harness² 自进化**：常驻自进化实验进程的监控面板
- **Agent Lightning**：训练/推理三组件（Gateway / Controller / Trainer）面板
- **抖音摸鱼**：内置浏览器刷抖音，可截图、抓标题、发评论
- **程序设置**：桌宠大小、气泡、特效开关

### QQ 机器人（`qqbot/`）

- 基于 `@tencent-connect/dsh-qqbot`，通过本地 dsh 运行时驱动
- **私聊/群聊白名单**：只回复名单内的 OpenID
- **主动发言**：按间隔让模型决定「现在要不要说」，带时段、最小间隔、每日上限、模型回退链
- **定时消息**：固定间隔推送，可选发送时段
- **富媒体**：图片、视频自动下载并交给模型/插件分析
- **人味插件**：发送前改写文本语气

### 本地桥接（`qqbot/bridge/bridge.js`，端口 18902）

大屏与机器人之间的控制层，提供：

| 接口 | 作用 |
|---|---|
| `GET /api/status` | 运行状态、二维码、白名单、主动发言状态 |
| `POST /api/start` / `/api/stop` | 启停机器人 |
| `POST /api/rebind` | 清除绑定并重新扫码 |
| `POST /api/whitelist` | 保存私聊/群聊白名单 |
| `POST /api/model` | 切换模型并重启机器人 |
| `POST /api/proactive` | 保存主动发言配置 |
| `POST /api/proactive/test` | 立即触发一次主动判断 |
| `GET/POST /api/harness2/*` | Harness² 自进化启停与状态 |
| `GET/POST /api/agl/*` | Agent Lightning 组件管理 |
| `* /api/tts*` | 语音合成代理 |

### MCP Server（`mcp-server/`）

把大屏内置的文件服务封装成标准 Model Context Protocol 工具，可在 Claude Desktop / Cursor / Trae 等客户端里直接操作大肥鱼的文件库。

### 抖音视频服务（`video-server/`）

用本机 Edge（Playwright）打开抖音网页版，提供首页抓取、下一条、实时画面推流、评论等接口。

---

## 目录结构

```
大肥鱼/
├─ index.html                 大屏前端（单文件，含全部面板逻辑）
├─ 大肥鱼大屏.exe             WebView2 桌面外壳
├─ keep_alive.js              守护进程：保活 bridge / ChatTTS / Edge-TTS
├─ assets/                    桌宠与界面素材
├─ qa/                        开发过程截图与验收图（可删）
├─ 素材_未使用/               未采用的素材（可删）
├─ installer/                 Inno Setup 打包脚本
├─ 安装包/                    已构建的安装包
├─ third_party/python311/     内置 Python 运行时（TTS 用）
├─ mcp-server/                MCP 服务
├─ video-server/              抖音视频服务
├─ tts/                       语音合成服务
│   ├─ tts_server.py          ChatTTS（离线，端口 18903）
│   └─ edge_tts_server.py     Edge-TTS（联网，端口 18904）
└─ qqbot/                     QQ 机器人
    ├─ config.json            机器人配置（API Key / 白名单 / 主动发言）
    ├─ config.template.json   配置模板
    ├─ start-qqbot.ps1        启动脚本（生成 patch 并拉起 dsh）
    ├─ bridge/                本地控制服务（端口 18902）
    ├─ patch/                 运行时生成的配置补丁
    ├─ plugins/               自定义 dsh 插件
    └─ .dsh/                  dsh profile 与依赖（含登录凭据）
```

---

## 运行环境

- Windows 10/11
- Node.js 22.19+ 或 24+
- Python 3.11（TTS，可使用 `third_party/python311`）
- WebView2 Runtime（大屏外壳依赖，Win11 自带）

---

## 快速开始

### 1. 启动大屏

直接双击 `大肥鱼大屏.exe`。

### 2. 启动后台服务

```powershell
node keep_alive.js
```

会依次检查并拉起：

| 服务 | 端口 |
|---|---|
| 大屏文件服务（exe 内置） | 18901 |
| QQ 机器人 bridge | 18902 |
| ChatTTS | 18903 |
| Edge-TTS | 18904 |
| 本地模型网关（独立项目） | 18900 |

启动后窗口可以关掉，子进程会继续运行；保持开着则每 30 秒自动保活。

### 3. 配置模型

大屏右上角 **⚙ AI 接口设置**：

- **DeepSeek 官方**：填自己的 API Key
- **Our Free Model 本地转发**：指向本地网关（默认 `http://127.0.0.1:18900/v1`）
- **本机 Ollama**：默认 `http://127.0.0.1:11434/v1`

推荐用本地网关模式，免费模型额度耗尽时会自动切换候选模型。

### 4. 绑定 QQ 机器人

1. 大屏右上角点 **QQBOT**
2. 点「▶ 启动机器人」，用手机 QQ 扫码
3. 绑定成功后凭据自动保存，下次无需再扫
4. 在 QQ 里给机器人发 `/bot-me` 获取 OpenID，填进白名单
5. 点「💾 保存白名单」

### 5. 打开主动发言（可选）

QQ 机器人面板底部「💬 主动找你说话」：

| 参数 | 说明 |
|---|---|
| 判断间隔 | 多久让模型判断一次要不要说话 |
| 最小间隔 | 两次主动消息之间的最短时间 |
| 每日上限 | 每天最多发几条 |
| 发送时段 | 只在这个时间窗内发（跨午夜也支持） |
| 主动聊什么 | 可选，引导它的话题倾向 |
| 备用模型 | 主模型限流时依次尝试 |

点「🧪 试一次」可以立刻验证一条。

---

## 常见问题

### 手机收到 `⚠️ 本轮异常结束 QUOTA: ...`

上游免费模型额度耗尽。项目已经做了两件事：

1. QQ 侧把这类技术错误替换成一句人话（原始错误仍写入 `bot.log`）
2. bridge 连续检测到额度错误时，自动切换到 `modelFallbacks` 里的下一个模型

想彻底避免，就在 AI 设置里换一个还能用的模型。

### 对话舱回复「收到你的消息：……」

这是旧版本的兜底文案，说明当时模型没连上。当前版本已改为自动换模型重试，只有全部失败才会提示。

### `Filename too long`

Windows 默认路径上限 260 字符，`node_modules` 深层目录会超。仓库已设置：

```powershell
git config core.longpaths true
```

### 大屏显示「网关: 离线」

本地网关（18900）没启动，或端口被占用。启动网关后刷新大屏即可。

### 机器人显示「二维码加载中…」很久

通常是 `dsh` 在下载依赖。项目已改为优先使用全局安装的 dsh：

```powershell
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
```

---

## 说明

- 本项目大量使用本机端口与本地进程，请勿在公网暴露 `18900-18904`。
- `qqbot/config.json` 与 `qqbot/.dsh/` 含有 API Key 与机器人凭据，提交到公开仓库前请务必替换为模板或加入 `.gitignore`。
- `third_party/python311/`、`node_modules/`、`video-server/.douyin-profile/` 属于运行时依赖，体积较大，更新仓库时建议排除。

## License

仅供个人学习与自用。
