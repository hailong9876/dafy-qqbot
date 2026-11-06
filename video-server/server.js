#!/usr/bin/env node
/**
 * 大肥鱼 · 抖音摸鱼视频服务
 * ------------------------------------------------------------------
 * 用本机 Edge（Playwright）打开抖音网页版，提供：
 *   GET  /api/ping          服务探活
 *   GET  /api/status        浏览器 / 登录 / 当前视频状态
 *   POST /api/login         打开抖音窗口（扫码或手机号登录，登录态保存在本地）
 *   POST /api/open          打开抖音首页
 *   POST /api/feed          读取首页视频卡片（标题/作者/封面）
 *   POST /api/next          刷下一条（自动打开视频、截图、抓取标题/评论）
 *   GET  /api/current       获取当前视频信息（不清屏）
 *   GET  /api/live.jpg      实时画面（CDP 推流，约 15-30fps）
 *   GET  /api/box           播放器在页面中的位置（前端裁切用）
 *   POST /api/comment       在当前视频下发评论（带限频与每日上限）
 *   POST /api/back          退出当前播放器
 *   POST /api/close         关闭浏览器
 *
 * 说明：抖音网页端的 DOM class 是混淆的，这里全部用多组选择器 + 文案兜底，
 * 任何一步失败都会返回可读原因，不会让服务崩溃。
 * ------------------------------------------------------------------
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DAFY_VIDEO_PORT || '18903', 10);
const PROFILE = join(HERE, '.douyin-profile');
const STATE_FILE = join(HERE, 'state.json');
const HOME = 'https://www.douyin.com/';
const MIN_COMMENT_GAP_MS = 30 * 1000;   // 两次评论至少间隔 30 秒
const MAX_DAILY_COMMENTS = 20;          // 每天最多发布 20 条

let ctx = null;          // 持久化浏览器上下文
let page = null;         // 当前页面
let launching = null;    // 防止并发重复启动
let current = null;      // 当前视频信息缓存
let lastError = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[video]', ...a);

/* ---------------- 浏览器生命周期 ---------------- */

async function launch() {
  if (ctx) return ctx;
  if (launching) return launching;
  launching = (async () => {
    await mkdir(PROFILE, { recursive: true });
    const opts = {
      headless: false,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-2400,0',
        '--window-size=1440,900',
        '--disable-notifications',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=AudioServiceOutOfProcess,CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
      ],
      channel: 'msedge',
    };
    try {
      ctx = await chromium.launchPersistentContext(PROFILE, opts);
    } catch (e) {
      // 本机没有 Edge 时退回 Playwright 自带 Chromium（若已安装）
      log('Edge 启动失败，尝试内置浏览器:', e.message);
      delete opts.channel;
      ctx = await chromium.launchPersistentContext(PROFILE, opts);
    }
    page = ctx.pages()[0] || (await ctx.newPage());
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {}
    }).catch(() => {});
    page.setDefaultTimeout(20000);
    ctx.on('close', () => {
      ctx = null; page = null; current = null;
      cdpSession = null; liveBuf = null;
      screencastOn = false; screencastHandler = null;
      log('浏览器已关闭');
    });
    log('浏览器已启动');
    // 默认把窗口移到屏幕外：后台播放，不遮挡大屏
    await setWindowVisible(false);
    return ctx;
  })().finally(() => { launching = null; });
  return launching;
}

async function ensurePage() {
  await launch();
  if (!page || page.isClosed()) {
    page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(20000);
  }
  return page;
}

async function openHome() {
  const p = await ensurePage();
  if (!/douyin\.com/.test(p.url())) {
    await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  }
  return p;
}

async function closeBrowser() {
  await stopScreencast();
  if (ctx) {
    try { await ctx.close(); } catch {}
  }
  ctx = null; page = null; current = null;
  cdpSession = null; liveBuf = null;
}

/* ---------------- 页面状态检测 ---------------- */

async function isLoggedIn() {
  if (!ctx) return false;
  try {
    const cookies = await ctx.cookies('https://www.douyin.com');
    return cookies.some(
      (c) => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name) && String(c.value || '').length > 8
    );
  } catch {
    return false;
  }
}

async function loginWallVisible(p) {
  try {
    return await p.evaluate(() => {
      const hasPhone = [...document.querySelectorAll('input')].some(
        (i) => /手机号|验证码/.test(i.getAttribute('placeholder') || '')
      );
      const txt = (document.body.innerText || '').slice(0, 1500);
      return hasPhone && /登录|扫码|验证码/.test(txt);
    });
  } catch {
    return false;
  }
}

/* ---------------- 读取视频信息 ---------------- */

async function readVideoInfo(p) {
  const info = await p.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const first = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        const t = clean(el?.innerText || el?.textContent);
        if (t) return t;
      }
      return '';
    };
    const meta = (prop) => {
      const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
      return clean(el?.getAttribute('content'));
    };
    const title = first([
      '[data-e2e="video-desc"]',
      '[data-e2e="video-title"]',
      '[class*="video-info-title"]',
      '[class*="videoDesc"]',
      'h1',
    ]) || meta('og:title') || clean(document.title).replace(/ - 抖音.*$/, '');
    const desc = first([
      '[data-e2e="video-desc"]',
      '[class*="video-desc"]',
      '[class*="videoInfoDesc"]',
    ]) || meta('og:description');
    const author = first([
      '[data-e2e="feed-video-nickname"]',
      '[data-e2e="video-author"]',
      '[data-e2e="video-author-name"]',
      '[class*="author-name"]',
      '[class*="videoAuthor"]',
    ]);
    const comments = [];
    const nodes = document.querySelectorAll(
      '[data-e2e="comment-item"], [class*="comment-item"], [class*="CommentItem"]'
    );
    for (const n of [...nodes].slice(0, 10)) {
      const t = clean(n.innerText);
      if (t) comments.push(t.slice(0, 120));
    }
    if (!comments.length) {
      const list = document.querySelector('[data-e2e="comment-list"]');
      const t = clean(list?.innerText);
      if (t) comments.push(t.slice(0, 300));
    }
    const v = document.querySelector('video');
    return {
      title,
      desc,
      author,
      comments,
      url: location.href,
      video: v
        ? {
            duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
            currentTime: Math.round(v.currentTime || 0),
            paused: !!v.paused,
            width: v.videoWidth || 0,
            height: v.videoHeight || 0,
          }
        : null,
      loginWall: [...document.querySelectorAll('input')].some(
        (i) => /手机号|验证码/.test(i.getAttribute('placeholder') || '')
      ),
    };
  });
  if (!info.title) info.title = '（未识别到标题）';
  return info;
}

async function playerBox(p) {
  return await p.evaluate(() => {
    const cand = [
      '[class*="video-player"]',
      '[class*="videoPlayer"]',
      '[class*="player-container"]',
      'video',
    ];
    let best = null;
    for (const s of cand) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 300) {
          if (!best || r.width * r.height > best.width * best.height) {
            best = { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
      }
    }
    if (!best) return null;
    const x = Math.max(0, Math.round(best.x));
    const y = Math.max(0, Math.round(best.y));
    return {
      x,
      y,
      width: Math.min(Math.round(best.width), innerWidth - x),
      height: Math.min(Math.round(best.height), innerHeight - y),
    };
  }).catch(() => null);
}

// 截图：走 CDP 并允许缩放，实时画面缩到 0.5 倍，显著降低编码开销
let cdpSession = null;
async function cdpFor(p) {
  if (!cdpSession) {
    try { cdpSession = await p.context().newCDPSession(p); } catch { cdpSession = null; }
  }
  return cdpSession;
}
// 把抖音窗口移出屏幕/移回屏幕（后台刷视频时不挡大屏）
async function setWindowVisible(show) {
  if (!page || page.isClosed()) return { ok: false, reason: '浏览器未打开' };
  try {
    const s = await cdpFor(page);
    if (!s) return { ok: false, reason: '拿不到浏览器会话' };
    const { windowId } = await s.send('Browser.getWindowForTarget');
    await s.send('Browser.setWindowBounds', {
      windowId,
      bounds: show
        ? { left: 40, top: 30, width: 1440, height: 900, windowState: 'normal' }
        : { left: -2400, top: 0 },
    });
    return { ok: true, visible: !!show };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
async function captureJpeg(p, quality, scale) {
  const box = await playerBox(p);
  const s = await cdpFor(p);
  if (s) {
    try {
      const r = await cdpSession.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        optimizeForSpeed: true,
        ...(box ? { clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale } } : {}),
      });
      return Buffer.from(r.data, 'base64');
    } catch {
      cdpSession = null;
    }
  }
  return await p.screenshot({ type: 'jpeg', quality, ...(box ? { clip: box } : {}) });
}

// ── 实时画面推流：CDP screencast，浏览器自己按变化持续推帧（约 15-30fps），
//    比反复调用截图接口快得多，CPU 也低得多 ──
let screencastOn = false;
let screencastHandler = null;
let lastLiveReq = 0;

async function startScreencast(p) {
  if (screencastOn) return true;
  const s = await cdpFor(p);
  if (!s) return false;
  screencastOn = true;
  screencastHandler = async (ev) => {
    try {
      liveBuf = Buffer.from(ev.data, 'base64');
      liveAt = Date.now();
      await s.send('Page.screencastFrameAck', { sessionId: ev.sessionId });
    } catch {}
  };
  s.on('Page.screencastFrame', screencastHandler);
  try {
    await s.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 58,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
    log('实时画面推流已开启');
    return true;
  } catch (e) {
    screencastOn = false;
    try { s.off('Page.screencastFrame', screencastHandler); } catch {}
    screencastHandler = null;
    return false;
  }
}

async function stopScreencast() {
  if (!screencastOn) return;
  screencastOn = false;
  try {
    if (cdpSession) {
      await cdpSession.send('Page.stopScreencast');
      if (screencastHandler) cdpSession.off('Page.screencastFrame', screencastHandler);
    }
  } catch {}
  screencastHandler = null;
}

// 面板关掉 15 秒后自动停推流，避免后台白耗 CPU
setInterval(() => {
  if (screencastOn && Date.now() - lastLiveReq > 15000) {
    stopScreencast();
    log('实时画面推流已暂停');
  }
}, 8000);

async function screenshot(p) {
  try {
    return 'data:image/jpeg;base64,' + (await captureJpeg(p, 62, 0.8)).toString('base64');
  } catch {
    return '';
  }
}

// 实时画面：低质量、带缓存，供大屏以 2fps 轮询（避免每次都重截全页）
let liveBuf = null;
let liveAt = 0;
let liveBusy = false;
let lastEnsureAt = 0;
async function liveShot(p) {
  if (liveBusy) return liveBuf;
  if (liveBuf && Date.now() - liveAt < 220) return liveBuf;
  liveBusy = true;
  try {
    const buf = await captureJpeg(p, 42, 0.5);   // 半分辨率 + 低质量，画面够看又不卡
    liveBuf = buf;
    liveAt = Date.now();
    return buf;
  } catch {
    return liveBuf;
  } finally {
    liveBusy = false;
  }
}

// 主动让播放器播起来（浏览器自动播放策略常导致视频停在 0 秒）
async function ensurePlaying(p) {
  try {
    await p.bringToFront().catch(() => {});
    return await p.evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return { ok: false, reason: 'no-video' };
      try { await v.play(); } catch (e) {
        try { v.muted = true; await v.play(); } catch {}
      }
      return { ok: !v.paused, paused: !!v.paused, muted: !!v.muted, t: v.currentTime };
    });
  } catch {
    return { ok: false, reason: 'play-failed' };
  }
}

async function snapshotCurrent(p) {
  const info = await readVideoInfo(p);
  const shot = await screenshot(p);
  current = {
    ...info,
    shot,
    shotAt: Date.now(),
  };
  return current;
}

/* ---------------- 刷视频 ---------------- */

async function collectCards(p, limit = 12) {
  return await p.evaluate((max) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const out = [];
    const nodes = document.querySelectorAll(
      '[class*="videoCardContainer"], [class*="discover-video-card-item"], [class*="jingxuanVideoCard"]'
    );
    for (const el of nodes) {
      const title = clean(el.innerText);
      if (!title || title.length < 6) continue;
      const img = el.querySelector('img');
      const key = title.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        index: out.length,
        title: title.slice(0, 160),
        cover: (img && (img.currentSrc || img.src)) || '',
      });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

async function clickCard(p, index = 0) {
  // 抖音卡片有多层嵌套，先筛出「可见且有面积」的卡片，再在页面里直接点击，
  // 避免被登录弹窗遮挡时 Playwright 干等 15 秒。
  const r = await p.evaluate((idx) => {
    const nodes = [...document.querySelectorAll(
      '[class*="videoCardContainer"], [class*="discover-video-card-item"], [class*="jingxuanVideoCard"]'
    )].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 140 && b.height > 90 && b.bottom > 60 && b.top < innerHeight;
    });
    if (!nodes.length) return { ok: false, count: 0 };
    const i = Math.max(0, Math.min(idx, nodes.length - 1));
    const el = nodes[i];
    el.setAttribute('data-dafy-pick', '1');
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, count: nodes.length, index: i };
  }, index).catch(() => ({ ok: false, count: 0 }));

  if (!r.ok) return { ok: false, reason: '页面上没有找到可点击的视频卡片（可能未登录或页面未加载完）' };
  await sleep(1500);
  if (!(await isPlaying(p))) {
    // 有些卡片只响应真实指针事件，再补一次强制点击
    await p.locator('[data-dafy-pick="1"]').first().click({ force: true, timeout: 5000 }).catch(() => {});
    await sleep(1500);
  }
  return { ok: true, count: r.count, index: r.index };
}

async function isPlaying(p) {
  return await p.evaluate(() => {
    if (/modal_id=/.test(location.href)) return true;
    const v = document.querySelector('video');
    if (!v) return false;
    const r = v.getBoundingClientRect();
    return r.width > 200 && r.height > 200;
  }).catch(() => false);
}

async function clickNext(p) {
  // 抖音播放器右侧有「下一条」箭头，优先点它；再退回键盘/滚轮
  const arrow = p.locator('[data-e2e="video-switch-next-arrow"]').first();
  try {
    if (await arrow.isVisible({ timeout: 1000 })) {
      await arrow.click({ timeout: 4000 });
      await sleep(1800);
      return;
    }
  } catch {}
  await p.keyboard.press('ArrowDown');
  await sleep(900);
  await p.keyboard.press('ArrowDown');
  await sleep(1200);
  const nextSels = [
    '[data-e2e="video-next"]',
    '[class*="next-video"]',
    '[aria-label*="下一条"]',
    '[title*="下一条"]',
  ];
  for (const s of nextSels) {
    try {
      const el = p.locator(s).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout: 3000 });
        await sleep(1500);
        return;
      }
    } catch {}
  }
  try {
    await p.mouse.wheel(0, 600);
  } catch {}
}

async function openFirstVideo(p, index = 0) {
  const r = await clickCard(p, index);
  if (!r.ok) return r;
  await sleep(4500);
  if (await loginWallVisible(p)) {
    return { ok: false, needLogin: true, reason: '抖音要求登录后才能看视频，请点「登录抖音」完成扫码' };
  }
  return { ok: true };
}

/* ---------------- 评论 ---------------- */

const COMMENT_INPUT_SELS = [
  '[class*="comment-input"] [contenteditable]:not([contenteditable="false"])',
  '[class*="comment-input"] .public-DraftEditor-content',
  '[class*="comment"] .public-DraftEditor-content',
  '.public-DraftEditor-content',
  '[class*="comment"] [contenteditable]:not([contenteditable="false"])',
  '[class*="comment"] textarea',
  'textarea[placeholder*="评论"]',
  '[data-e2e="comment-input"] [contenteditable]',
];

async function findCommentInput(p) {
  for (const s of COMMENT_INPUT_SELS) {
    const loc = p.locator(s);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 400 }))) continue;
        const info = await el.evaluate((e) => {
          const ph = e.getAttribute('placeholder') || '';
          const txt = (e.innerText || '').slice(0, 40);
          let par = e.parentElement;
          let inComment = false;
          for (let k = 0; k < 6 && par; k++) {
            if (/comment/i.test(String(par.className || ''))) { inComment = true; break; }
            par = par.parentElement;
          }
          const r = e.getBoundingClientRect();
          return { ph, txt, inComment, w: r.width, h: r.height };
        });
        // 抖音的占位文案是「留下你的精彩评论吧」，输入后占位会消失，
        // 所以除了文案，只要在 comment 容器里也算通过
        if (/评论|说点什么|留下|善语/.test(info.ph + ' ' + info.txt) || info.inComment) return el;
      } catch {}
    }
  }
  return null;
}

async function openCommentPanel(p) {
  if (await findCommentInput(p)) return true;
  // 只点一次：多个选择器可能指向同一个图标，重复点击会把刚展开的评论区又关掉
  const icon = p.locator([
    '[data-e2e="feed-comment-icon"]',
    '[data-e2e*="comment-icon"]',
    '[class*="comment-icon"]',
    '[aria-label*="评论"]',
    '[title*="评论"]',
  ].join(',')).first();
  try {
    if (await icon.isVisible({ timeout: 1200 })) {
      await icon.click({ timeout: 4000 });
      await sleep(3000);
    }
  } catch {}
  if (await findCommentInput(p)) return true;
  // 评论区展开了，但输入框还是「留下你的精彩评论吧」占位符，点一下才会变成可输入状态
  const box = p.locator('[class*="comment-input-inner-container"], [class*="comment-input"]').first();
  try {
    if (await box.isVisible({ timeout: 1200 })) {
      await box.click({ timeout: 4000 });
      await sleep(2000);
    }
  } catch {}
  return !!(await findCommentInput(p));
}

const readEditor = (e) =>
  e.tagName === 'TEXTAREA' || e.tagName === 'INPUT' ? String(e.value || '') : String(e.innerText || '');

// 评论区真正的发送键：输入栏右侧最后一个带 svg 的 span（红色箭头，无文字）
async function clickCommentSend(p) {
  return await p.evaluate(() => {
    const right = document.querySelector('[class*="commentInput-right"], [class*="comment-input-right"]');
    if (!right) return false;
    const spans = [...right.querySelectorAll('span')].filter((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && s.querySelector('svg');
    });
    if (!spans.length) return false;
    const btn = spans[spans.length - 1];
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    btn.click();
    return true;
  }).catch(() => false);
}

async function typeComment(p, text) {
  const steps = [];
  const input = await findCommentInput(p);
  if (!input) return { ok: false, reason: '没有找到评论输入框（可能没有登录，或评论区未展开）', steps };

  // 先清空可能残留的草稿
  try {
    await input.click({ timeout: 4000 });
    await p.keyboard.press('Control+A');
    await p.keyboard.press('Delete');
    await input.evaluate((e) => {
      e.focus();
      if (e.tagName === 'TEXTAREA' || e.tagName === 'INPUT') e.value = '';
    });
  } catch {}
  steps.push('输入框已定位');

  // 逐字输入，接近真人
  await p.keyboard.type(text, { delay: 85 });
  await sleep(900);
  let typed = '';
  try { typed = await input.evaluate(readEditor); } catch {}
  if (!typed.trim()) {
    // 占位态没激活：再点一次输入框重输
    try {
      await input.click({ timeout: 3000 });
      await p.keyboard.type(text, { delay: 85 });
      await sleep(900);
      typed = await input.evaluate(readEditor);
    } catch {}
  }
  if (!typed.trim()) {
    return { ok: false, reason: '文字没能进入评论框（抖音页面结构可能变了）', steps };
  }
  steps.push('文字已填入');

  // 发送：抖音评论区 Enter 即发送
  await p.keyboard.press('Enter');

  // 注意：发送成功后 React 会重建编辑器，原来的句柄会失效，
  // 所以每次都重新定位输入框再判断是否已清空，避免“发了却报失败”
  const checkSent = async () => {
    await sleep(1400);
    const fresh = await findCommentInput(p);
    if (!fresh) return true;                 // 输入框消失 → 已发送
    try {
      const v = await fresh.evaluate(readEditor);
      return !String(v || '').trim();
    } catch {
      return true;                           // 句柄失效 → 视为已发送
    }
  };
  if (await checkSent()) { steps.push('Enter 已提交'); return { ok: true, steps }; }

  // Enter 没反应：点评论区里真正的「发送」按钮（排除弹幕条上的发送）
  try {
    const clicked = await p.evaluate(() => {
      const cand = [...document.querySelectorAll('div,button,span')].filter((e) => {
        const t = (e.textContent || '').trim();
        if (t !== '发送') return false;
        if (/danmaku/i.test(String(e.className || ''))) return false;
        if (e.closest('[class*="danmaku"]')) return false;
        const r = e.getBoundingClientRect();
        return r.width > 10 && r.height > 10 && r.width < 220 && r.height < 70;
      });
      if (!cand.length) return false;
      cand.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      cand[0].click();
      return true;
    }).catch(() => false);
    if (clicked) {
      steps.push('已点发送按钮');
      if (await checkSent()) return { ok: true, steps };
    }
  } catch {}

  // 输入框没清空，但评论可能已经出现在列表里了
  const appeared = await p
    .evaluate((t) => (document.body.innerText || '').includes(t), text.slice(0, 10))
    .catch(() => false);
  if (appeared) { steps.push('评论已出现在列表'); return { ok: true, steps }; }

  // 没发出去就把草稿清掉，避免下次评论叠在一起
  try {
    await input.click({ timeout: 2000 });
    await p.keyboard.press('Control+A');
    await p.keyboard.press('Delete');
  } catch {}
  steps.push('提交后输入框未清空');
  return { ok: false, reason: '内容已输入，但没检测到发送成功（可到抖音窗口手动确认）', steps };
}

/* ---------------- 发布限额 ---------------- */

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { date: '', count: 0, lastPostAt: 0 };
  }
}
async function saveState(s) {
  try { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
function today() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

async function checkCommentLimit() {
  const s = await loadState();
  if (s.date !== today()) return { ok: true, state: { date: today(), count: 0, lastPostAt: s.lastPostAt || 0 } };
  if (s.count >= MAX_DAILY_COMMENTS) {
    return { ok: false, reason: `今天已经发了 ${s.count} 条，达到每日上限 ${MAX_DAILY_COMMENTS} 条` };
  }
  if (Date.now() - (s.lastPostAt || 0) < MIN_COMMENT_GAP_MS) {
    const wait = Math.ceil((MIN_COMMENT_GAP_MS - (Date.now() - s.lastPostAt)) / 1000);
    return { ok: false, reason: `发得太快啦，再等 ${wait} 秒` };
  }
  return { ok: true, state: s };
}

/* ---------------- HTTP ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return json(res, 204, {});

  try {
    if (path === '/api/ping' || path === '/api/status') {
      const p = page && !page.isClosed() ? page : null;
      const st = await loadState();
      const dailyCount = st.date === today() ? st.count || 0 : 0;
      return json(res, 200, {
        ok: true,
        running: !!ctx,
        loggedIn: await isLoggedIn(),
        pageUrl: p ? p.url() : '',
        title: p ? await p.title().catch(() => '') : '',
        current: current
          ? { title: current.title, author: current.author, url: current.url, shotAt: current.shotAt }
          : null,
        dailyCount,
        dailyLimit: MAX_DAILY_COMMENTS,
        lastError,
      });
    }

    if (path === '/api/login' || path === '/api/open') {
      const p = await openHome();
      if (path === '/api/login') {
        if (!/douyin\.com/.test(p.url())) {
          await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(2000);
        }
        // 登录需要看到二维码：把窗口移回屏幕内
        await setWindowVisible(true);
      }
      return json(res, 200, {
        ok: true,
        loggedIn: await isLoggedIn(),
        tip: (await isLoggedIn()) ? '已登录' : '浏览器已打开，请在窗口里扫码或手机号登录，登录一次后会记住',
      });
    }

    if (path === '/api/debug/cookies') {
      const cs = ctx ? await ctx.cookies('https://www.douyin.com') : [];
      return json(res, 200, {
        cookies: cs.map((c) => ({ name: c.name, len: String(c.value || '').length })),
      });
    }

    if (path === '/api/debug/dom') {
      const p = await ensurePage();
      const dom = await p.evaluate(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const brief = (el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 90),
            e2e: el.getAttribute('data-e2e'),
            title: el.getAttribute('title'),
            aria: el.getAttribute('aria-label'),
            txt: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
          };
        };
        return {
          e2e: [...new Set([...document.querySelectorAll('[data-e2e]')].map((e) => e.getAttribute('data-e2e')))],
          commentEls: [...document.querySelectorAll('[class*="comment" i]')].filter(vis).slice(0, 40).map(brief),
          rightEls: [...document.querySelectorAll('button,div,span,svg')]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return vis(el) && r.x > innerWidth - 120 && r.width < 110;
            }).slice(0, 60).map(brief),
          editables: [...document.querySelectorAll('[contenteditable],textarea,input')]
            .filter(vis).slice(0, 30).map(brief),
          commentHTML: (document.querySelector('[class*="comment-input-inner-container"]')?.outerHTML || '').slice(0, 2000),
        };
      });
      return json(res, 200, { ok: true, dom });
    }

    if (path === '/api/feed') {
      const p = await openHome();
      await sleep(2500);
      const cards = await collectCards(p, 15);
      return json(res, 200, {
        ok: true,
        loggedIn: await isLoggedIn(),
        needLogin: !(await isLoggedIn()),
        cards,
      });
    }

    if (path === '/api/next') {
      const body = await readBody(req);
      let p = await openHome();
      await p.bringToFront().catch(() => {});
      if (await loginWallVisible(p)) {
        return json(res, 200, {
          ok: false,
          needLogin: true,
          reason: '抖音要求登录后才能看视频，请在大屏点「登录抖音」完成扫码',
        });
      }
      // 已经在播放器里就直接下一条；否则先点开一个视频卡片
      const playing = await isPlaying(p);
      const beforeUrl = p.url();
      if (!playing) {
        const opened = await openFirstVideo(p, Number(body.index) || 0);
        if (!opened.ok) {
          lastError = opened.reason || '';
          return json(res, 200, { ok: false, needLogin: !!opened.needLogin, reason: opened.reason });
        }
      } else {
        await clickNext(p);
        await sleep(2000);
        if (p.url() === beforeUrl) {
          // 键盘下移没生效：点一下播放器再试，最后用滚轮
          await p.locator('video').first().click({ timeout: 3000 }).catch(() => {});
          await p.keyboard.press('ArrowDown');
          await sleep(1500);
          if (p.url() === beforeUrl) {
            await p.mouse.wheel(0, 700);
            await sleep(2000);
          }
        }
      }
      await sleep(1500);
      await ensurePlaying(p);   // 抖音默认会自动暂停，主动播起来
      await sleep(700);
      if (await loginWallVisible(p)) {
        return json(res, 200, { ok: false, needLogin: true, reason: '登录后才能真正播放，请点「登录抖音」' });
      }
      const snap = await snapshotCurrent(p);
      lastError = '';
      return json(res, 200, { ok: true, loggedIn: await isLoggedIn(), video: snap });
    }

    if (path === '/api/live.jpg') {
      if (!page || page.isClosed()) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end('browser-not-running');
      }
      lastLiveReq = Date.now();
      // 保持播放：面板在刷新画面时顺手把被暂停的视频播起来（每 4 秒最多一次）
      if (Date.now() - lastEnsureAt > 4000) {
        lastEnsureAt = Date.now();
        ensurePlaying(page).catch(() => {});
      }
      await startScreencast(page);
      let buf = null;
      if (liveBuf && Date.now() - liveAt < 1200) buf = liveBuf;  // 推流帧，直接返回
      if (!buf) buf = await liveShot(page);                        // 推流刚启动还没出帧，退回截图
      if (!buf) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end('no-frame');
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      return res.end(buf);
    }

    // 播放器在页面里的位置：前端据此把整窗推流裁成“只剩视频”
    if (path === '/api/box') {
      if (!page || page.isClosed()) return json(res, 200, { ok: false, reason: '浏览器未启动' });
      const vp = page.viewportSize() || { width: 1440, height: 900 };
      const box = await playerBox(page);
      return json(res, 200, { ok: true, vw: vp.width, vh: vp.height, box });
    }

    if (path === '/api/current') {
      if (!page || page.isClosed()) return json(res, 200, { ok: false, reason: '浏览器未启动' });
      await ensurePlaying(page);
      await sleep(500);
      const snap = await snapshotCurrent(page);
      return json(res, 200, { ok: true, video: snap });
    }

    if (path === '/api/comment') {
      const body = await readBody(req);
      if (body.dry) {
        const p = await ensurePage();
        const found = await openCommentPanel(p);
        return json(res, 200, { ok: true, dry: true, inputFound: found });
      }
      const text = String(body.text || '').trim();
      if (!text) return json(res, 200, { ok: false, reason: '评论内容为空' });
      if (text.length > 60) return json(res, 200, { ok: false, reason: '评论太长（最多 60 字）' });
      if (!(await isLoggedIn())) return json(res, 200, { ok: false, needLogin: true, reason: '还没登录抖音' });
      const lim = await checkCommentLimit();
      if (!lim.ok) return json(res, 200, { ok: false, reason: lim.reason });

      const p = await ensurePage();
      await p.bringToFront().catch(() => {});
      if (!(await openCommentPanel(p))) {
        return json(res, 200, { ok: false, reason: '评论区打不开（可能当前没在播放视频）' });
      }
      const r = await typeComment(p, text);
      if (!r.ok) return json(res, 200, r);

      const now = today();
      const st = lim.state.date === now ? lim.state : { date: now, count: 0, lastPostAt: 0 };
      st.count = (st.count || 0) + 1;
      st.lastPostAt = Date.now();
      await saveState(st);
      return json(res, 200, { ok: true, text, count: st.count, limit: MAX_DAILY_COMMENTS });
    }

    if (path === '/api/back') {
      if (!page || page.isClosed()) return json(res, 200, { ok: false, reason: '浏览器未启动' });
      await page.keyboard.press('Escape');
      await sleep(600);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/debug/send') {
      const p = await ensurePage();
      const opened = await openCommentPanel(p);
      if (!opened) return json(res, 200, { ok: false, reason: '评论区没打开', inputFound: false });
      const text = (url.searchParams.get('text') || '测试一下').slice(0, 30);
      const input = await findCommentInput(p);
      if (!input) return json(res, 200, { ok: false, reason: '没找到输入框', inputFound: false });
      try {
        await input.click({ timeout: 4000 });
        await p.keyboard.type(text, { delay: 60 });
        await sleep(1200);
      } catch {}
      const typed = await input.evaluate(readEditor).catch(() => '');
      const near = await input.evaluate((e) => {
        let c = e;
        for (let i = 0; i < 5 && c.parentElement; i++) c = c.parentElement;
        return String(c.outerHTML || '').slice(0, 2600);
      }).catch(() => '');
      const bar = await p.evaluate(() => {
        const c = document.querySelector('[class*="comment-input-inner-container"]');
        let par = c;
        for (let i = 0; i < 2 && par && par.parentElement; i++) par = par.parentElement;
        return par ? String(par.outerHTML || '').slice(0, 5000) : '';
      }).catch(() => '');
      const candidates = await p.evaluate(() => {
        const out = [];
        const seen = new Set();
        document.querySelectorAll('*').forEach((el) => {
          const cls = String(el.className || '');
          const txt = (el.textContent || '').trim().slice(0, 10);
          const lab = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
          if (!(/send/i.test(cls) || txt === '发送' || /发送/.test(lab))) return;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return;
          const key = el.tagName + cls + txt + Math.round(r.x) + Math.round(r.y);
          if (seen.has(key)) return;
          seen.add(key);
          out.push({
            tag: el.tagName,
            cls: cls.slice(0, 100),
            txt,
            lab: lab.trim().slice(0, 40),
            disabled: el.disabled === true || el.getAttribute('aria-disabled'),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          });
        });
        return out.slice(0, 30);
      }).catch(() => []);
      // 清掉草稿，不发送
      try { await input.click({ timeout: 2000 }); await p.keyboard.press('Control+A'); await p.keyboard.press('Delete'); } catch {}
      return json(res, 200, { ok: true, inputFound: true, typed, candidates, near, bar });
    }

    if (path === '/api/window') {
      const b = await readBody(req);
      const show = b.show !== false && b.show !== 'false' && b.show !== 0;
      const r = await setWindowVisible(show);
      return json(res, 200, r);
    }

    if (path === '/api/close') {
      await closeBrowser();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, reason: '未知接口' });
  } catch (e) {
    lastError = (e && e.message) || String(e);
    log('接口出错', path, lastError);
    return json(res, 200, { ok: false, reason: lastError.slice(0, 300) });
  }
}

const server = http.createServer(handle);
server.listen(PORT, '127.0.0.1', () => {
  log(`已启动 http://127.0.0.1:${PORT}`);
  log(`浏览器配置目录: ${PROFILE}`);
  registerLauncher();
});

// 注册 dafyv:// 协议：大屏在服务离线时点「启动视频服务」可以直接拉起本服务
function registerLauncher() {
  if (process.platform !== 'win32') return;
  const cmdFile = join(HERE, '启动视频服务.cmd');
  const run = (args) => {
    try {
      const p = spawn('reg', args, { windowsHide: true, stdio: 'ignore' });
      p.on('error', () => {});
    } catch {}
  };
  run(['add', 'HKCU\\Software\\Classes\\dafyv', '/ve', '/t', 'REG_SZ', '/d', 'URL:dafyv video launcher', '/f']);
  run(['add', 'HKCU\\Software\\Classes\\dafyv', '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']);
  run(['add', 'HKCU\\Software\\Classes\\dafyv\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', `"${cmdFile}"`, '/f']);
}

const shutdown = async () => {
  log('正在退出…');
  await closeBrowser();
  server.close();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
