/**
 * dsh-video-analyzer — QQ 视频分析
 *
 * 给模型一个 qqbot_analyze_video 工具，它会：
 *   1. ffprobe 拿时长、分辨率、编码
 *   2. 抽 3 帧（前 1/4、中间、后 3/4）
 *   3. 如果有 ggml whisper 模型，FFmpeg whisper filter 做音频转写
 *
 * 依赖：
 *   - FFmpeg（系统 PATH 或 FFMPEG_PATH 环境变量）
 *   - 可选：whisper.cpp ggml 模型（ggml-base.bin 等），放 ~/.dsh-qqbot/models/whisper/
 */

import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const name = 'dsh-video-analyzer'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 环境探测：ffmpeg、ffprobe 路径。支持 FFMPEG_PATH 环境变量显式指定。 */
const which = (() => {
  let cached = null
  return async function whichBin() {
    if (cached) return cached
    const tryList = []
    if (process.env.FFMPEG_PATH) {
      const f = process.env.FFMPEG_PATH
      tryList.push({ ffmpeg: f, ffprobe: f.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') })
    }
    tryList.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
    // winget 默认安装路径
    const wingetBase = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
      : ''
    if (wingetBase) {
      try {
        const fs = await import('node:fs')
        const pkgDirs = fs.readdirSync(wingetBase).filter((n) => n.toLowerCase().startsWith('gyan.ffmpeg'))
        for (const pkg of pkgDirs) {
          const pkgPath = join(wingetBase, pkg)
          function walk(dir, depth = 0) {
            if (depth > 4) return null
            let st
            try { st = fs.statSync(dir) } catch { return null }
            if (!st.isDirectory()) return null
            const check = join(dir, 'bin', 'ffmpeg.exe')
            try { fs.accessSync(check); return dir } catch {}
            for (const name of fs.readdirSync(dir)) {
              const r = walk(join(dir, name), depth + 1)
              if (r) return r
            }
            return null
          }
          const found = walk(pkgPath)
          if (found) {
            tryList.push({ ffmpeg: join(found, 'bin', 'ffmpeg.exe'), ffprobe: join(found, 'bin', 'ffprobe.exe') })
          }
        }
      } catch {}
    }
    for (const t of tryList) {
      try {
        await access(t.ffmpeg)
        await access(t.ffprobe)
        cached = t
        return cached
      } catch {}
    }
    cached = null
    return cached
  }
})()

/** 视觉 API 配置：默认走本地免费网关 */
function visionConfig() {
  return {
    baseUrl: (process.env.DSH_VISION_BASE_URL || 'http://127.0.0.1:18900/v1').replace(/\/+$/, ''),
    apiKey: process.env.DSH_VISION_API_KEY || '',
    model: process.env.DSH_VISION_MODEL || 'mimo-v2.6-flash-free',
  }
}

/** 按扩展名猜 MIME（失败兜底 jpeg） */
function guessMime(p) {
  const s = String(p).toLowerCase()
  if (s.endsWith('.png')) return 'image/png'
  if (s.endsWith('.gif')) return 'image/gif'
  if (s.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

/** 用 FFmpeg 把图片压到长边 1280 的 jpeg，减小体积和 token 消耗 */
async function prepareImage(imagePath, ffmpeg) {
  const orig = await readFile(imagePath)
  if (!ffmpeg) return { data: orig, mime: guessMime(imagePath) }
  const out = join(tmpdir(), 'dsh-vision-' + Math.random().toString(36).slice(2, 8) + '.jpg')
  const r = await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', imagePath,
    '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease',
    '-q:v', '3', out,
  ], { timeout: 30_000 })
  if (r.code !== 0) return { data: orig, mime: guessMime(imagePath) }
  const data = await readFile(out)
  rm(out, { force: true }).catch(() => {})
  return { data, mime: 'image/jpeg' }
}

/** 调 OpenAI 兼容的视觉接口 */
async function callVision(imagePath, prompt, bins) {
  const cfg = visionConfig()
  const { data, mime } = await prepareImage(imagePath, bins?.ffmpeg)
  const b64 = data.toString('base64')
  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    max_tokens: 900,
  }
  const resp = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok) {
    const msg = json?.error?.message || JSON.stringify(json) || String(resp.status)
    throw new Error(`视觉接口 ${resp.status}: ${String(msg).slice(0, 300)}`)
  }
  const text = json?.choices?.[0]?.message?.content
  return String(text ?? '').trim()
}

/** 找 whisper ggml 模型（base 优先，没有用 tiny） */
function findWhisperModel() {
  const home = process.env.USERPROFILE || process.env.HOME || tmpdir()
  const candidates = [
    join(home, '.dsh-qqbot', 'models', 'whisper', 'ggml-base.bin'),
    join(home, '.dsh-qqbot', 'models', 'whisper', 'ggml-tiny.bin'),
    join(ROOT, 'models', 'ggml-base.bin'),
    join(ROOT, 'models', 'ggml-tiny.bin'),
  ]
  return candidates.find((p) => {
    try { require('node:fs').accessSync(p); return true } catch { return false }
  })
}

/** 简单 spawn 包装：run 命令，返回 { stdout, stderr, code } */
function run(cmd, args, { timeout = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, timeout, env: process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout: out, stderr: err, code: code ?? -1 }))
  })
}

/** ffprobe 拿视频元数据 */
async function probe(videoPath, ffprobe) {
  const r = await run(ffprobe, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', videoPath,
  ])
  if (r.code !== 0) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

/** FFmpeg 抽帧：给路径、输出目录、时长、要抽的时间点数组(秒) → 返回帧文件路径数组 */
async function extractFrames(videoPath, ffmpeg, outDir, durationSec, timestamps) {
  await mkdir(outDir, { recursive: true })
  const frames = []
  for (let i = 0; i < timestamps.length; i++) {
    const t = Math.max(0, Math.min(durationSec - 0.1, timestamps[i]))
    const out = join(outDir, `frame_${i + 1}.jpg`)
    const r = await run(ffmpeg, [
      '-y', '-ss', String(t), '-i', videoPath,
      '-vframes', '1', '-q:v', '2', out,
    ], { timeout: 30_000 })
    if (r.code === 0) {
      frames.push({ path: out, timeSec: t })
    }
  }
  return frames
}

/** FFmpeg whisper filter ASR：把视频音频抽出来转文字 */
async function whisperTranscribe(videoPath, ffmpeg, modelPath) {
  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-',
    '-af', `whisper=model=${modelPath}`,
    '-f', 'null', '-',
  ], { timeout: 180_000 })
  // whisper filter 把转写文本打到 stderr（FFmpeg 的默认），同时可能在 stdout 有
  const text = (r.stderr + '\n' + r.stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.toLowerCase().includes('whisper') && !l.includes('Error') && !l.includes('error'))
    .join('\n')
    .trim()
  return text || ''
}

export function apply(root, config = {}) {
  // 不在启动时硬探测 ffmpeg，避免用户没装就报错；工具调用时再探测
  root.inject(['tools'], (ctx) => {
    ctx.tools.register({
      name: 'qqbot_analyze_video',
      description: `分析一段视频：抽关键帧、读时长分辨率、（如果有 whisper 模型）转写音频里说的话。

- video: 本地视频文件路径（绝对路径，通常是下载到 ~/.dsh-qqbot/media 里的那个）
- frames: 抽几帧，默认 3（前 1/4、中间、后 3/4）
- prompt: 可选，额外的分析指令（如"重点看屏幕上的文字"）

如果系统没装 FFmpeg 或没找到 whisper 模型，工具会返回可用的部分信息，不会整体失败。`,
      parameters: {
        type: 'object',
        properties: {
          video: { type: 'string', description: '本地视频文件路径（绝对路径）' },
          frames: { type: 'number', description: '抽几帧，默认 3' },
          prompt: { type: 'string', description: '额外分析指令（可选）' },
        },
        required: ['video'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        const video = String(args?.video ?? '').trim()
        if (!video) return { ok: false, text: '需要 video 参数（本地视频绝对路径）' }

        const bins = await which()
        if (!bins) {
          return { ok: false, text: '系统没找到 FFmpeg。请装 FFmpeg 后再试（或设 FFMPEG_PATH 环境变量指向 ffmpeg.exe）。' }
        }

        // 检查文件
        try { await access(video) } catch {
          return { ok: false, text: `视频文件不存在：${video}` }
        }

        // 1. probe 元数据
        const meta = await probe(video, bins.ffprobe)
        const parts = []
        let duration = 0
        if (meta?.format) {
          const d = Number(meta.format.duration || 0)
          duration = isFinite(d) ? d : 0
          const size = Number(meta.format.size || 0)
          const format = meta.format.format_name || 'unknown'
          const v = (meta.streams || []).find((s) => s.codec_type === 'video')
          if (v) {
            parts.push(`视频时长 ${duration.toFixed(1)}s，分辨率 ${v.width}x${v.height}，编码 ${v.codec_name}`)
          } else {
            parts.push(`视频时长 ${duration.toFixed(1)}s，格式 ${format}，大小 ${(size / 1024 / 1024).toFixed(1)}MB`)
          }
        }

        // 2. 抽帧
        const n = Math.max(1, Math.min(6, Number(args?.frames) || 3))
        const dir = join(tmpdir(), 'dsh-video-' + Math.random().toString(36).slice(2, 8))
        const timestamps = duration > 0 && n >= 2
          ? Array.from({ length: n }, (_, i) => duration * (i / (n - 1)))
          : [0]
        const frames = await extractFrames(video, bins.ffmpeg, dir, duration, timestamps)
        if (frames.length) {
          parts.push(`已抽 ${frames.length} 帧（时间点：${frames.map((f) => `${f.timeSec.toFixed(1)}s`).join(', ')}）`)
          // 自动用视觉模型描述每一帧
          if (visionConfig().apiKey) {
            const desc = []
            for (const f of frames.slice(0, 3)) {
              try {
                const t = await callVision(f.path, '用简短中文描述这一帧画面里有什么（人物、物体、文字、场景）。', bins)
                if (t) desc.push(`- ${f.timeSec.toFixed(1)}s: ${t}`)
              } catch (err) {
                desc.push(`- ${f.timeSec.toFixed(1)}s: 描述失败（${String(err?.message || err).slice(0, 80)}）`)
              }
            }
            if (desc.length) {
              parts.push('画面描述：')
              parts.push(desc.join('\n'))
            }
          } else {
            parts.push('帧文件（可用 qqbot_look_image 逐帧查看）：')
            for (const f of frames) parts.push(`  - ${f.path}`)
          }
        } else {
          parts.push('抽帧失败（视频可能损坏或格式不支持）')
        }

        // 3. whisper ASR（可选）
        const model = findWhisperModel()
        if (model) {
          try {
            const text = await whisperTranscribe(video, bins.ffmpeg, model)
            if (text) {
              parts.push('音频转写（whisper）：')
              parts.push(text.slice(0, 2000))
            } else {
              parts.push('有 whisper 模型但没识别出语音（可能视频没声音或语音太短）')
            }
          } catch (err) {
            parts.push('whisper 转写出错：' + (err?.message || String(err)).slice(0, 200))
          }
        } else {
          parts.push('（未找到 whisper ggml 模型，跳过音频转写。如需此能力，下载 ggml-base.bin 到 ~/.dsh-qqbot/models/whisper/）')
        }

        // 4. 可选 prompt
        if (args?.prompt) parts.push(`额外指令：${args.prompt}`)

        // 5. 清理临时帧（保留 30 秒让模型有机会用 vision 工具看）
        setTimeout(() => {
          rm(dir, { recursive: true, force: true }).catch(() => {})
        }, 60_000)

        return { ok: true, text: parts.join('\n') }
      },
    })

    ctx.tools.register({
      name: 'qqbot_look_image',
      description: `看图：分析一张本地图片（或 http/https 图片地址），返回画面描述、图中的文字（OCR）、表格、界面截图等信息。
QQ 消息里出现 "Image: C:/..." 这样的本地路径时，用这个工具了解图片内容。`,
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '本地图片绝对路径，或 http(s) 图片链接' },
          prompt: { type: 'string', description: '你想从图片里得到什么（可选，默认详细描述）' },
        },
        required: ['image'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        const image = String(args?.image ?? '').trim()
        if (!image) return { ok: false, text: '需要 image 参数（本地路径或 http 链接）' }
        const prompt = String(args?.prompt ?? '').trim() || '详细描述这张图片：画面里有什么、主要物体和人物、其中出现的文字（逐字转写）、整体氛围。'
        const bins = await which()

        // 网络图片先下载到临时文件
        let local = image
        let tempFile = ''
        if (/^https?:\/\//i.test(image)) {
          try {
            const resp = await fetch(image, { signal: AbortSignal.timeout(30_000) })
            if (!resp.ok) return { ok: false, text: `图片下载失败 HTTP ${resp.status}` }
            const buf = Buffer.from(await resp.arrayBuffer())
            tempFile = join(tmpdir(), 'dsh-img-' + Math.random().toString(36).slice(2, 8) + '.jpg')
            await (await import('node:fs/promises')).writeFile(tempFile, buf)
            local = tempFile
          } catch (err) {
            return { ok: false, text: `图片下载失败：${String(err?.message || err).slice(0, 120)}` }
          }
        } else {
          try { await access(local) } catch {
            return { ok: false, text: `图片文件不存在：${local}` }
          }
        }

        try {
          const cfg = visionConfig()
          if (!cfg.apiKey) {
            return { ok: false, text: '视觉服务未配置（缺少 DSH_VISION_API_KEY）。' }
          }
          const t = await callVision(local, prompt, bins)
          return t
            ? { ok: true, text: t }
            : { ok: false, text: '视觉模型返回了空内容。' }
        } catch (err) {
          return { ok: false, text: '图片识别失败：' + String(err?.message || err).slice(0, 200) }
        } finally {
          if (tempFile) rm(tempFile, { force: true }).catch(() => {})
        }
      },
    })
  })
}
