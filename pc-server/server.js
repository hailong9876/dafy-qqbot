#!/usr/bin/env node
/**
 * 大肥鱼 · 电脑控制服务（端口 18907）
 * ------------------------------------------------------------------
 * 给大屏 AI 提供「看屏幕 + 动鼠标键盘」的能力，全部走本机 PowerShell，
 * 不依赖任何第三方库（原生模块），也不联网。
 *
 *   GET  /api/ping              探活
 *   POST /api/screen/look       看屏幕：窗口列表 + OCR 文字及其坐标
 *   POST /api/screen/capture    仅截图，返回图片 dataUrl（供界面预览/多模态）
 *   POST /api/screen/ocr        仅 OCR
 *   POST /api/windows           窗口列表
 *   POST /api/window/focus      激活窗口 {hwnd}
 *   POST /api/mouse             鼠标 {action:move|click|double|right|wheel, x, y, delta}
 *   POST /api/type              输入文字 {text}（支持中文）
 *   POST /api/key               按键 / 快捷键 {keys:'ctrl+c'}
 * ------------------------------------------------------------------
 */
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');

const PORT = parseInt(process.env.DAFY_PC_PORT || '18907', 10);
const PS1 = path.join(__dirname, 'native.ps1');
const SHOT_DIR = path.join(os.tmpdir(), 'dafy-pc');
const SHOT_KEEP = 6;

const log = (...a) => console.log('[pc]', ...a);

function runNative(action, payload, timeout = 25000) {
  return new Promise((resolve) => {
    if (!payload) payload = {};
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PS1, '-Action', action, '-Arg', b64,
    ], { windowsHide: true });

    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ps.kill(); } catch {}
      resolve({ ok: false, reason: `操作超时（${timeout}ms）: ${action}` });
    }, timeout);

    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: '无法启动 PowerShell: ' + e.message });
    });
    ps.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, reason: '底层脚本没有返回 JSON: ' + (err.trim() || line).slice(0, 300) });
      }
    });
  });
}

async function ensureShotDir() {
  await fsp.mkdir(SHOT_DIR, { recursive: true });
}

async function pruneShots() {
  try {
    const names = (await fsp.readdir(SHOT_DIR)).filter((n) => n.endsWith('.png')).sort();
    for (const n of names.slice(0, Math.max(0, names.length - SHOT_KEEP))) {
      await fsp.rm(path.join(SHOT_DIR, n), { force: true });
    }
  } catch {}
}

/** 截一张全屏图，落地为 PNG，返回 {ok, path, width, height} */
async function capture() {
  await ensureShotDir();
  const file = path.join(SHOT_DIR, `shot-${Date.now()}.png`);
  const r = await runNative('capture', { path: file }, 20000);
  if (r.ok) {
    const st = await fsp.stat(file).catch(() => null);
    r.bytes = st ? st.size : 0;
    pruneShots();
  }
  return r;
}

/** 看屏幕：窗口 + OCR 文字（带坐标），一次截图完成 */
async function look(opts = {}) {
  const shot = await capture();
  if (!shot.ok) return shot;
  const ocr = await runNative('ocr', { path: shot.path }, 30000);
  const wins = await runNative('windows', {}, 20000);
  let words = Array.isArray(ocr.words) ? ocr.words : [];
  // 按行、再按横坐标排序，合并成短语时才不会出现负宽度
  words = words.slice().sort((a, b) => (Math.abs(a.y - b.y) <= 6 ? a.x - b.x : a.y - b.y));
  const maxWords = Math.max(10, Math.min(Number(opts.maxWords) || 80, 300));
  if (words.length > maxWords) words = words.slice(0, maxWords);
  // 同一条线上的词合并成短语，AI 更好读
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - w.y) <= 6 && Math.abs(last.h - w.h) <= 8) {
      last.t += w.t;
      last.x2 = Math.max(last.x2, w.x + w.w);
    } else {
      lines.push({ t: w.t, x: w.x, y: w.y, h: w.h, x2: w.x + w.w });
    }
  }
  return {
    ok: true,
    screen: { width: shot.width, height: shot.height },
    shot: shot.path,
    ocrOk: !!ocr.ok,
    ocrReason: ocr.ok ? '' : ocr.reason,
    text: String(ocr.text || '').slice(0, 4000),
    lines: lines.map((l) => ({ t: l.t.slice(0, 80), x: l.x, y: l.y, w: l.x2 - l.x, h: l.h })),
    foreground: wins.ok ? wins.foreground : 0,
    windows: wins.ok
      ? wins.windows.slice(0, 25).map((w) => ({ hwnd: w.hwnd, title: String(w.title).slice(0, 80), proc: w.proc, x: w.x, y: w.y, w: w.w, h: w.h }))
      : [],
    windowsReason: wins.ok ? '' : wins.reason,
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/api/ping') {
      return json(res, 200, { ok: true, service: 'dafy-pc', port: PORT, pid: process.pid });
    }

    const body = req.method === 'POST' ? await readBody(req) : {};

    if (p === '/api/screen/look') {
      return json(res, 200, await look(body));
    }

    if (p === '/api/screen/capture') {
      const shot = await capture();
      if (!shot.ok) return json(res, 200, shot);
      const base = {
        ok: true, width: shot.width, height: shot.height,
        left: shot.left, top: shot.top, bytes: shot.bytes, shot: shot.path,
      };
      if (body.dataUrl === false) return json(res, 200, base);
      const buf = await fsp.readFile(shot.path);
      return json(res, 200, { ...base, image: 'data:image/png;base64,' + buf.toString('base64') });
    }

    if (p === '/api/screen/ocr') {
      const shot = await capture();
      if (!shot.ok) return json(res, 200, shot);
      const r = await runNative('ocr', { path: shot.path }, 30000);
      return json(res, 200, { ...r, width: shot.width, height: shot.height, shot: shot.path });
    }

    if (p === '/api/windows') {
      const r = await runNative('windows', {}, 20000);
      return json(res, 200, r);
    }

    if (p === '/api/window/focus') {
      if (body.hwnd == null) return json(res, 200, { ok: false, reason: '缺少 hwnd' });
      return json(res, 200, await runNative('focus', { hwnd: body.hwnd }, 15000));
    }

    if (p === '/api/mouse') {
      const act = String(body.action || 'click').toLowerCase();
      if (!['move', 'click', 'double', 'right', 'wheel'].includes(act)) {
        return json(res, 200, { ok: false, reason: 'action 只能是 move/click/double/right/wheel' });
      }
      const x = Number(body.x);
      const y = Number(body.y);
      if (act !== 'wheel' && (!Number.isFinite(x) || !Number.isFinite(y))) {
        return json(res, 200, { ok: false, reason: '缺少坐标 x/y' });
      }
      return json(res, 200, await runNative('mouse', {
        action: act, x: Math.round(x) || 0, y: Math.round(y) || 0,
        delta: Number.isFinite(Number(body.delta)) ? Math.round(Number(body.delta)) : -120,
      }, 15000));
    }

    if (p === '/api/type') {
      const text = String(body.text == null ? '' : body.text);
      if (!text) return json(res, 200, { ok: false, reason: '缺少要输入的文字' });
      if (text.length > 2000) return json(res, 200, { ok: false, reason: '单次输入不要超过 2000 字' });
      return json(res, 200, await runNative('type', { text }, 30000));
    }

    if (p === '/api/apps/list') {
      return json(res, 200, await runNative('apps', {}, 20000));
    }

    if (p === '/api/apps/open') {
      const name = String(body.name == null ? '' : body.name).trim();
      if (!name) return json(res, 200, { ok: false, reason: '缺少程序名' });
      return json(res, 200, await runNative('launch', { name }, 30000));
    }

    if (p === '/api/key') {
      const keys = String(body.keys || '').trim();
      if (!keys) return json(res, 200, { ok: false, reason: '缺少 keys，例如 ctrl+c' });
      return json(res, 200, await runNative('key', { keys }, 15000));
    }

    return json(res, 404, { ok: false, reason: '未知接口: ' + p });
  } catch (e) {
    return json(res, 200, { ok: false, reason: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`电脑控制服务已启动: http://127.0.0.1:${PORT}`);
});

process.on('uncaughtException', (e) => log('未捕获异常:', e.message));
