# 外部贡献与致谢

这个插件的一些修复，最初的判断或实现来自社区。**这里只列代码/修法被采纳、并写进提交 `Co-authored-by` 的人**
（整包合入的 PR 作者由 git 历史自动计入）；其余只提了问题或线索的朋友，我在各条 PR / issue 下另行道谢，不列在这里。

| 人 | 采纳了什么 |
|---|---|
| [@wotorrrrr](https://github.com/wotorrrrr) | `uv venv` 钉 Python 3.10–3.13（3.14+ 没有 `av` / `ctranslate2` 的 wheel）；私信模式必须把 `bili_send_message` 放进 MCP 白名单；数组类设置不能用 `!==` 比默认值 |
| [@Rookiexg](https://github.com/Rookiexg) | headless overlay 要补 `agent-default-model`，否则账号登录的机器会 `MISSING_CREDENTIAL`（PR #50） |
| [@383891598](https://github.com/383891598) | yt-dlp 的进度条会污染 stdout，导致"输出非空 = 成功"恒真（PR #23，部分采纳） |

| [@Annoias](https://github.com/Annoias) | **看画面**：bili_cover / bili_frames 两个工具（用 B站 故事板裁帧、不下视频）+ 章程「什么时候该看画面」+ 看图纯函数自检（**PR #92，已整包合入**） |
| [@Anguis-L](https://github.com/Anguis-L) | **同源检查要比端口**（只比 hostname 会让本机别的端口的页面驱动写接口）+ 栅栏入参按契约传 headers（PR #94 的思路，已在自己的实现里采纳） |
| [@LUOXI23333](https://github.com/LUOXI23333) | **值班轮最小权限 profile + 窄口 IO 工具**的整体思路（issue #96 / PR #97）——这版按这个思路独立实现，取舍写在 #96 的回复里 |

## 关于"为什么不整包合 PR"

这个仓库的做法是**一条一条读、把修法自己在 main 上实现**，而不是整包合并 —— 这样发布节奏在自己手上、出问题好定位回滚。
但**采纳的思路照样算贡献**，所以上面这几位写进了提交的 `Co-authored-by`。如果你提的东西被用上了却没在这张表里，开个 issue 说一声，我补上。

---
*本文件只做署名，不构成任何额外许可条款。*

- @KunnnnnQ（#128 凭证 SID 授权 · #133 判重表短日期）
