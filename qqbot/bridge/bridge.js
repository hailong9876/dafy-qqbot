/* 大肥鱼 QQ 机器人本地控制服务
 * 默认监听 http://127.0.0.1:18902
 * 供大肥鱼大屏调用：启动/停止机器人、显示扫码二维码、读写白名单
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const qrcode = require('qrcode');

const QB = path.resolve(__dirname, '..');
const CONFIG = path.join(QB, 'config.json');
const SCRIPT = path.join(QB, 'start-qqbot.ps1');
const PROFILE_PATCH = path.join(QB, '.dsh', 'profiles', 'qqbot', 'cordis.patch.yml');
const LOG = path.join(QB, 'bot.log');
const PORT = 18902;

let child = null;
let running = false;
let bindUrl = '';
let qrData = '';
let outBuf = '';
let lines = [];
let logTimer = null;
let afterBindTimer = null;
let bindHandled = false;
// 免费模型额度耗尽是常态：连续命中就自动换到下一个候选模型
let _quotaHits = 0;
let _lastModelSwitch = 0;

function noteQuota() {
  _quotaHits++;
  if (_quotaHits < 2) return;
  if (Date.now() - _lastModelSwitch < 10 * 60000) return;
  const cfg = readConfig();
  const list = Array.isArray(cfg.modelFallbacks) ? cfg.modelFallbacks.filter(Boolean) : [];
  if (!list.length) return;
  const cur = String(cfg.deepseekModel || '');
  const idx = list.indexOf(cur);
  const next = list[(idx + 1 + list.length) % list.length];
  if (!next || next === cur) return;
  _quotaHits = 0;
  _lastModelSwitch = Date.now();
  cfg.deepseekModel = next;
  writeConfig(cfg);
  try { writeLlmPatch(cfg); } catch (e) {}
  pushLine('[模型] 免费额度耗尽，自动切换到 ' + next);
  if (running) { stopBot(); setTimeout(startBot, 1500); }
}

function scheduleAfterBind() {
  bindUrl = ''; qrData = '';
  if (bindHandled || !boundAppId()) return;
  bindHandled = true;
  if (afterBindTimer) return;
  afterBindTimer = setTimeout(() => {
    afterBindTimer = null;
    stopBot();
    setTimeout(startBot, 1500);
  }, 2500);
}

function decodeLog(buf) {
  const u16 = buf.toString('utf16le');
  const u8 = buf.toString('utf8');
  const score = (s) => (s.indexOf('http') >= 0 ? 2 : 0) + (s.indexOf('Bot ready') >= 0 ? 2 : 0) + (s.indexOf('二维码') >= 0 ? 1 : 0);
  return score(u16) >= score(u8) ? u16 : u8;
}
function scanLog() {
  try {
    const text = decodeLog(fs.readFileSync(LOG));
    const urls = text.match(/https:\/\/q\.qq\.com\/qqbot\/openclaw\/connect\.html\?[^\s\u001b"'<>]+/g);
    if (urls && urls.length) {
      const last = urls[urls.length - 1];
      if (last !== bindUrl) {
        bindUrl = last;
        qrcode.toDataURL(last, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
          .then((d) => { qrData = d; })
          .catch(() => {});
      }
    }
    if (text.indexOf('Bot ready!') >= 0) { bindUrl = ''; qrData = ''; }
    if (text.indexOf('扫码绑定成功') >= 0) scheduleAfterBind();
  } catch (e) { /* 日志被占用时忽略 */ }
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
function boundAppId() {
  try {
    const t = fs.readFileSync(PROFILE_PATCH, 'utf8');
    const m = t.match(/appId:\s*"?([^"\r\n]+)"?/);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}
function pushLine(s) {
  const t = s.trim();
  if (!t) return;
  lines.push(t);
  if (lines.length > 300) lines = lines.slice(-300);
}
function handleOutput(chunk) {
  const s = chunk.toString('utf8');
  outBuf += s;
  if (outBuf.length > 20000) outBuf = outBuf.slice(-20000);
  s.split(/\r?\n/).forEach(pushLine);
  const m = outBuf.match(/https:\/\/q\.qq\.com\/qqbot\/openclaw\/connect\.html\?[^\s\u001b"'<>]+/);
  if (m && m[0] !== bindUrl) {
    bindUrl = m[0];
    qrcode.toDataURL(bindUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
      .then((d) => { qrData = d; })
      .catch(() => {});
  }
  if (/Bot ready!/.test(s)) { bindUrl = ''; qrData = ''; }
  if (/扫码绑定成功/.test(s)) scheduleAfterBind();
  if (/Free usage limit reached|QUOTA:|quota_exceeded|Free models work in OpenCode/i.test(s)) noteQuota();
}
function listYaml(name, items, indent) {
  if (!items || !items.length) return indent + name + ': []';
  return indent + name + ':\n' + items.map((i) => indent + '  - ' + i).join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// QQ 主动消息发送（走 QQ 机器人开放平台 REST API，不依赖 dsh 进程）
// ─────────────────────────────────────────────────────────────────────
const https = require('https');
const QQ_API_BASE = process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com';
let _qqToken = { token: '', expireAt: 0 };
function getQQCredentials() {
  try {
    const t = fs.readFileSync(PROFILE_PATCH, 'utf8');
    const appId = (t.match(/appId:\s*"?([^"\r\n]+)"?/) || [])[1] || '';
    const appSecret = (t.match(/appSecret:\s*"?([^"\r\n]+)"?/) || [])[1] || '';
    return { appId: appId.trim(), appSecret: appSecret.trim() };
  } catch (e) { return { appId: '', appSecret: '' }; }
}
function httpRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(opts.url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(opts.timeout || 120000, () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function getQQAccessToken() {
  const now = Date.now();
  if (_qqToken.token && now < _qqToken.expireAt - 60000) return _qqToken.token;
  const { appId, appSecret } = getQQCredentials();
  if (!appId || !appSecret) throw new Error('未配置 QQ 机器人 appId/appSecret');
  const r = await httpRequest({
    url: QQ_API_BASE + '/app/getAppAccessToken', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ appId, clientSecret: appSecret }));
  const obj = JSON.parse(r.body);
  if (!obj.access_token) throw new Error('获取 access_token 失败: ' + r.body);
  _qqToken = { token: obj.access_token, expireAt: now + (obj.expires_in || 7200) * 1000 };
  return _qqToken.token;
}
async function sendQQMessage(targetType, targetId, content) {
  if (!targetId || !content) throw new Error('targetId 和 content 不能为空');
  const token = await getQQAccessToken();
  const path = targetType === 'group'
    ? `/v2/groups/${encodeURIComponent(targetId)}/messages`
    : `/v2/users/${encodeURIComponent(targetId)}/messages`;
  const r = await httpRequest({
    url: QQ_API_BASE + path, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'QQBot ' + token },
  }, JSON.stringify({ content: String(content) }));
  if (r.status >= 200 && r.status < 300) return { ok: true };
  throw new Error(`发送失败 (${r.status}): ${r.body.slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────────────────
// 主动发言（proactive）
// 设计参考 google-research/harness2 与 dsh-superagent 的"每次主动都基于判断"思路：
// 到点先让模型判断"现在有没有值得说的话"，说 SKIP 就不发，避免刷屏。
// ─────────────────────────────────────────────────────────────────────
const PROACTIVE_STATE = path.join(QB, 'proactive-state.json');
let _proactiveTimer = null;
let _proactiveBusy = false;

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function proactiveCfg() {
  const cfg = readConfig();
  const p = (cfg && cfg.proactive) || {};
  return {
    enabled: !!p.enabled,
    intervalMinutes: clampNum(p.intervalMinutes, 5, 1440, 60),
    minGapMinutes: clampNum(p.minGapMinutes, 10, 2880, 180),
    dailyLimit: clampNum(p.dailyLimit, 1, 20, 3),
    startHour: clampNum(p.startHour, 0, 23, 9),
    endHour: clampNum(p.endHour, 0, 24, 23),
    targetType: p.targetType === 'group' ? 'group' : 'c2c',
    targetId: String(p.targetId || ''),
    hint: String(p.hint || ''),
    fallbackModels: Array.isArray(p.fallbackModels)
      ? p.fallbackModels.map((x) => String(x || '').trim()).filter(Boolean)
      : ['big-pickle', 'pulse-alpha-free']
  };
}
function loadProactiveState() {
  try { return JSON.parse(fs.readFileSync(PROACTIVE_STATE, 'utf8')); } catch (e) { return {}; }
}
function saveProactiveState(s) {
  try { fs.writeFileSync(PROACTIVE_STATE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) {}
}
function proactiveTarget(p) {
  if (p.targetId) return p.targetId;
  const cfg = readConfig();
  const list = p.targetType === 'group'
    ? (Array.isArray(cfg.groupAllow) ? cfg.groupAllow : [])
    : (Array.isArray(cfg.c2cAllow) ? cfg.c2cAllow : []);
  return list.find(Boolean) || '';
}
function proactiveInWindow(p, d) {
  const h = d.getHours();
  if (p.startHour === p.endHour) return true;
  if (p.startHour < p.endHour) return h >= p.startHour && h < p.endHour;
  return h >= p.startHour || h < p.endHour;
}
async function chatComplete(messages, opts) {
  const cfg = readConfig();
  const ollama = cfg.llmMode === 'ollama';
  const gw = !ollama && cfg.useLocalGateway;
  const base = ollama
    ? (cfg.ollamaBase || 'http://127.0.0.1:11434/v1')
    : gw ? (cfg.gatewayBase || 'http://127.0.0.1:18899/v1')
         : (cfg.deepseekBaseUrl || 'https://api.deepseek.com');
  const model = (opts && opts.model) || (ollama
    ? (cfg.ollamaModel || '')
    : gw ? (cfg.gatewayModel || '')
         : (cfg.deepseekModel || 'deepseek-chat'));
  const key = ollama ? '' : (gw ? (cfg.gatewayKey || '') : (cfg.deepseekApiKey || ''));
  if (!model) throw new Error('未配置模型（先在大屏 ⚙ AI 接口设置里选一个）');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const payload = JSON.stringify({
    model,
    messages,
    max_tokens: (opts && opts.maxTokens) || 200,
    temperature: (opts && opts.temperature) != null ? opts.temperature : 0.95,
    stream: false
  });
  const r = await httpRequest({
    url: String(base).replace(/\/+$/, '') + '/chat/completions',
    method: 'POST', headers, timeout: (opts && opts.timeout) || 90000
  }, payload);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`模型 HTTP ${r.status}: ${r.body.slice(0, 160)}`);
  }
  const obj = JSON.parse(r.body);
  const msg = obj && obj.choices && obj.choices[0] && obj.choices[0].message;
  return String((msg && msg.content) || '').trim();
}

// 跑一次判断。force=true 时忽略开关/间隔/上限（「试一次」用），但仍尊重时间窗之外的手动触发。
async function proactiveTick(force) {
  if (_proactiveBusy) return { ok: false, skipped: 'busy' };
  _proactiveBusy = true;
  const p = proactiveCfg();
  const st = loadProactiveState();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  try {
    if (!p.enabled && !force) return { ok: true, skipped: 'disabled' };
    if (!running) return { ok: true, skipped: '机器人未启动' };
    if (!force && !proactiveInWindow(p, now)) return { ok: true, skipped: '不在发送时段' };
    if (st.day !== today) { st.day = today; st.sentToday = 0; }
    if (!force) {
      const lastCheck = st.lastCheckAt ? new Date(st.lastCheckAt).getTime() : 0;
      if (Date.now() - lastCheck < p.intervalMinutes * 60000) return { ok: true, skipped: '未到判断间隔' };
      const lastSent = st.lastSentAt ? new Date(st.lastSentAt).getTime() : 0;
      if (Date.now() - lastSent < p.minGapMinutes * 60000) return { ok: true, skipped: '距上次发言太近' };
      if ((st.sentToday || 0) >= p.dailyLimit) return { ok: true, skipped: '已达今日上限' };
    }
    st.lastCheckAt = now.toISOString();
    const target = proactiveTarget(p);
    if (!target) {
      st.lastError = '没有可用的发送对象（白名单为空）';
      return { ok: false, skipped: '没有可用的发送对象' };
    }
    const cfg = readConfig();
    const persona = String(cfg.persona || '你是「大肥鱼」，一只穿女仆装的人鱼小精灵。');
    const gapMin = st.lastSentAt
      ? Math.round((Date.now() - new Date(st.lastSentAt).getTime()) / 60000)
      : -1;
    const sys = [
      persona,
      '',
      '现在不是用户在跟你聊天，而是你要主动给用户发一条消息。',
      '规则：',
      '1. 你平时就爱跟主人说话，默认倾向于说点什么（关心、吐槽、分享小日常都行）。',
      '2. 只有两种情况才输出 SKIP：刚才已经主动说过、或者这个时间点明显不合适。',
      '3. 要发就只写消息本身，1-2 句，口语化，像真人朋友。',
      '4. 不要解释你为什么发，不要加引号，不要用「你好」「在吗」这种空话开头。'
    ].join('\n');
    const usr = [
      '现在时间：' + now.toLocaleString('zh-CN', { hour12: false }),
      gapMin < 0 ? '你还没主动找过用户说话。' : `距上次主动说话：${gapMin} 分钟前。`,
      `今天已经主动说了 ${st.sentToday || 0} 次（上限 ${p.dailyLimit}）。`,
      p.hint ? '额外倾向：' + p.hint : '',
      '请判断并输出。'
    ].filter(Boolean).join('\n');

    // 主模型失败（常见是免费额度 429）时按 fallback 链依次重试
    const msgs = [{ role: 'system', content: sys }, { role: 'user', content: usr }];
    const useFallback = String(cfg.llmMode || '') !== 'ollama';
    const candidates = [''].concat(useFallback ? (p.fallbackModels || []) : []);
    let reply = '';
    let lastErr = '';
    let usedModel = '';
    for (const m of candidates) {
      try {
        const r = await chatComplete(msgs, { model: m || undefined });
        // 空回复说明这个模型这次没正常输出，换下一个，不能当成「不说话」
        if (!r || !r.trim()) { lastErr = `模型 ${m || '主模型'} 返回空内容`; continue; }
        reply = r;
        lastErr = '';
        usedModel = m || '主模型';
        break;
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (lastErr) {
      st.lastError = lastErr;
      saveProactiveState(st);
      pushLine('[主动] 判断失败: ' + lastErr);
      return { ok: false, error: lastErr };
    }
    st.lastError = '';
    st.lastModel = usedModel;
    if (!reply || /^skip\b/i.test(reply)) {
      saveProactiveState(st);
      pushLine('[主动] 这次判断为：不说话');
      return { ok: true, skipped: '模型判断这次不说话', raw: reply.slice(0, 120) };
    }
    // 去掉模型偶尔加上的包裹引号/前缀
    const text = reply.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    try {
      await sendQQMessage(p.targetType, target, text);
    } catch (e) {
      st.lastError = e.message;
      saveProactiveState(st);
      pushLine('[主动] 发送失败: ' + e.message);
      return { ok: false, error: e.message };
    }
    st.lastSentAt = now.toISOString();
    st.sentToday = (st.sentToday || 0) + 1;
    st.lastText = text;
    saveProactiveState(st);
    pushLine(`[主动] 已发送(${p.targetType}): ${text.slice(0, 60)}`);
    return { ok: true, sent: true, text, targetType: p.targetType, targetId: target };
  } finally {
    _proactiveBusy = false;
  }
}
function startProactive() {
  if (_proactiveTimer) return;
  _proactiveTimer = setInterval(() => {
    proactiveTick(false).catch((e) => pushLine('[主动] 异常: ' + e.message));
  }, 60000);
}

// ─────────────────────────────────────────────────────────────────────
// 定时任务调度
// ─────────────────────────────────────────────────────────────────────
let _schedTimer = null;
function loadScheduledTasks() {
  const cfg = readConfig();
  return Array.isArray(cfg.scheduledTasks) ? cfg.scheduledTasks : [];
}
function saveScheduledTasks(tasks) {
  const cfg = readConfig();
  cfg.scheduledTasks = tasks;
  writeConfig(cfg);
}
function dueTasks(now) {
  return loadScheduledTasks().filter((t) => t.enabled && t.nextRun && new Date(t.nextRun).getTime() <= now);
}
// 判断当前时刻是否在任务允许的发送时段内（按本地小时）
// startHour/endHour 为 0-23；若 startHour<=endHour 则窗口为 [startHour, endHour)
// 若 startHour>endHour 则跨午夜，窗口为 [startHour,24) ∪ [0,endHour)
function isWithinActiveWindow(task, date) {
  const h = date.getHours();
  const s = Number.isFinite(task.startHour) ? task.startHour : 8;
  const e = Number.isFinite(task.endHour) ? task.endHour : 23;
  if (s === e) return true; // 相同时表示全天
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}
async function runScheduledTask(task) {
  try {
    await sendQQMessage(task.targetType, task.targetId, task.content);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function tickScheduledTasks() {
  const now = Date.now();
  const nowDate = new Date(now);
  const tasks = loadScheduledTasks();
  let changed = false;
  for (const t of tasks) {
    if (!t.enabled || !t.nextRun) continue;
    if (new Date(t.nextRun).getTime() > now) continue;
    // 不在允许发送时段内 → 跳过本次发送，仍推进下次时间
    if (!isWithinActiveWindow(t, nowDate)) {
      pushLine(`[定时] ${t.name || t.id} → 非发送时段（${t.startHour ?? 8}:00-${t.endHour ?? 23}:00），跳过`);
    } else {
      runScheduledTask(t).then((r) => {
        pushLine(`[定时] ${t.name || t.id} → ${r.ok ? '成功' : '失败: ' + r.error}`);
      }).catch((e) => pushLine(`[定时] ${t.name || t.id} 异常: ${e.message}`));
    }
    // 计算下次运行时间
    const intervalMs = Math.max(60000, (parseInt(t.intervalMinutes, 10) || 60) * 60000);
    t.lastRun = new Date(now).toISOString();
    t.nextRun = new Date(now + intervalMs).toISOString();
    changed = true;
  }
  if (changed) saveScheduledTasks(tasks);
}
function startScheduler() {
  if (_schedTimer) return;
  _schedTimer = setInterval(tickScheduledTasks, 30000); // 每 30 秒检查一次
  tickScheduledTasks();
}

function memoryFiles() {
  const dir = path.resolve(QB, '../../..', 'Conversation_Records');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^dafy_memory.*\.json$/i.test(f));
  } catch (e) { return []; }
  return files.map((f) => {
    const p = path.join(dir, f);
    try { return { p, t: fs.statSync(p).mtimeMs }; } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => b.t - a.t);
}
function memoryLatest() {
  return memoryFiles()[0] || null;
}
function loadSharedMemory() {
  for (const it of memoryFiles()) {
    try {
      const obj = JSON.parse(fs.readFileSync(it.p, 'utf8'));
      if (!Array.isArray(obj.facts) || !obj.facts.length) continue;
      const facts = obj.facts.map((x) => String(x).trim()).filter(Boolean);
      const isVideo = (s) => s.indexOf('【刷视频】') === 0;
      // 视频记忆最多 12 条，其余（用户本人相关）优先，总量上限 60
      const personal = facts.filter((s) => !isVideo(s)).slice(0, 48);
      const video = facts.filter(isVideo).slice(0, 12);
      return personal.concat(video);
    } catch (e) {}
  }
  return [];
}
let lastMemCount = 0;

// 写 llm.patch.yml（按 config.json 里当前 llmMode 选分支）
function writeLlmPatch(cfg) {
  const dir = path.join(QB, 'patch');
  fs.mkdirSync(dir, { recursive: true });
  let llmPath = null;
  if (cfg.llmMode === 'ollama') {
    const base = cfg.ollamaBase || 'http://127.0.0.1:11434/v1';
    const model = cfg.ollamaModel || 'deepseek-r1:14b';
    const llm = ['- id: llm-pi-ai', '  config:', '    providers:', '      ollama:',
      '        displayName: 本机 Ollama', '        apiKeyEnv: DAFY_OLLAMA_KEY',
      '        api: openai-completions', '        baseURL: ' + base,
      '        models:', '          - id: "' + model + '"', '            name: "' + model + '"',
      '            contextWindow: 4096', '            maxTokens: 400',
      '- id: agent-default-model', '  config:', '    provider: ollama', '    model: "' + model + '"'].join('\n');
    llmPath = path.join(dir, 'llm.patch.yml');
    fs.writeFileSync(llmPath, llm + '\n', 'utf8');
  } else if (cfg.deepseekApiKey) {
    const base = cfg.deepseekBaseUrl || 'https://api.deepseek.com';
    const model = cfg.deepseekModel || 'deepseek-chat';
    const llm = ['- id: llm-deepseek-account', '  disabled: true',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY', '    baseURL: ' + base,
      '- id: web-search-deepseek', '  disabled: true',
      '- id: web-deepseek-api', '  disabled: true',
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: ' + model].join('\n');
    llmPath = path.join(dir, 'llm.patch.yml');
    fs.writeFileSync(llmPath, llm + '\n', 'utf8');
  } else if (cfg.useLocalGateway) {
    const model = cfg.gatewayModel || 'deepseek-v4.1-flash-free';
    const llm = ['- id: llm-pi-ai', '  config:', '    providers:', '      dafy:',
      '        displayName: 大肥鱼本地网关', '        apiKeyEnv: DAFY_GW_KEY',
      '        api: openai-completions', '        baseURL: ' + (cfg.gatewayBase || 'http://127.0.0.1:18899/v1'),
      '        models:', '          - id: ' + model, '            name: ' + model,
      '            contextWindow: 32768', '            maxTokens: 4096',
      '- id: agent-default-model', '  config:', '    provider: dafy', '    model: ' + model].join('\n');
    llmPath = path.join(dir, 'llm.patch.yml');
    fs.writeFileSync(llmPath, llm + '\n', 'utf8');
  }
  return llmPath;
}

function preparePatches() {
  const cfg = readConfig();
  const dir = path.join(QB, 'patch');
  fs.mkdirSync(dir, { recursive: true });
  const pt = fs.existsSync(PROFILE_PATCH) ? fs.readFileSync(PROFILE_PATCH, 'utf8') : '';
  const appId = (pt.match(/appId:\s*"?([^"\r\n]+)"?/) || [])[1] || '';
  const appSecret = (pt.match(/appSecret:\s*"?([^"\r\n]+)"?/) || [])[1] || '';
  const c2c = Array.isArray(cfg.c2cAllow) ? cfg.c2cAllow.filter(Boolean) : [];
  const group = Array.isArray(cfg.groupAllow) ? cfg.groupAllow.filter(Boolean) : [];
  const mode = cfg.discover ? 'open' : 'allowlist';
  const gmode = (cfg.groupOpen || cfg.discover) ? 'open' : 'allowlist';
  const wl = ['- id: im-qqbot', '  config:'];
  if (appId && appSecret) {
    wl.push('    appId: "' + appId + '"');
    wl.push('    appSecret: "' + appSecret + '"');
  }
  wl.push('    requireMention: ' + (cfg.requireMention === false ? 'false' : 'true'));
  const mem = loadSharedMemory();
  lastMemCount = mem.length;
  try { fs.writeFileSync(path.join(dir, 'debug.txt'), 'mem=' + mem.length + ' dir=' + path.resolve(QB, '../../..', 'Conversation_Records')); } catch (e) {}
  const promptParts = [];
  if (cfg.persona) promptParts.push(cfg.persona);
  if (mem.length) promptParts.push('【关于用户的记忆】\n' + mem.map((f) => '- ' + f).join('\n'));
  promptParts.push('【媒体理解】消息里出现 "Image: 路径" 时，必须先调用 qqbot_look_image 工具真正看过图片再回答；出现 "Video: 路径" 时，必须先调用 qqbot_analyze_video 工具分析视频再回答。不要凭文件名猜测内容。');
  const prompt = promptParts.join('\n\n');
  if (prompt) {
    wl.push('    directPrompt: |');
    prompt.split(/\r?\n/).forEach((line) => wl.push('      ' + line));
    wl.push('    groupPrompt: |');
    prompt.split(/\r?\n/).forEach((line) => wl.push('      ' + line));
  }
  wl.push('    access:');
  wl.push('      c2cMode: ' + mode);
  wl.push(listYaml('c2cAllow', c2c, '      '));
  wl.push('      groupMode: ' + gmode);
  wl.push(listYaml('groupAllow', group, '      '));
  // 富媒体：图片/视频自动下载到本地 ~/.dsh-qqbot/media
  wl.push('    media:');
  wl.push('      enabled: true');
  wl.push('      maxMB: 200');
  wl.push('      ttlHours: 24');
  // 视觉理解：需要配一个支持 image 输入的多模态模型
  //   provider/model 留空时 qqbot_describe_image 工具不会注册（模型不支持就不配）
  wl.push('    vision:');
  wl.push('      enabled: true');
  wl.push('      provider: ""');
  wl.push('      model: ""');
  wl.push('      defaultPrompt: "请详细描述这张图片里有什么。"');
  const wlPath = path.join(dir, 'whitelist.patch.yml');
  fs.writeFileSync(wlPath, wl.join('\n') + '\n', 'utf8');

  const env = Object.assign({}, process.env, {
    DSH_HOME: path.join(QB, '.dsh'),
    PATH: path.join(process.env.APPDATA || '', 'npm') + ';' + process.env.PATH,
    QQBOT_BIND_OPEN_BROWSER: '0'
  });
  // FFmpeg：winget 装的默认不在 PATH，手动加进去
  {
    const localAppData = process.env.LOCALAPPDATA || '';
    const wingetBase = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    try {
      const entries = fs.readdirSync(wingetBase).filter((n) => n.toLowerCase().startsWith('gyan.ffmpeg'));
      for (const pkg of entries) {
        function walk(dir, depth = 0) {
          if (depth > 4) return null;
          let st; try { st = fs.statSync(dir) } catch { return null }
          if (!st.isDirectory()) return null;
          const check = path.join(dir, 'bin', 'ffmpeg.exe');
          try { fs.accessSync(check); return dir } catch {}
          for (const name of fs.readdirSync(dir)) {
            const r = walk(path.join(dir, name), depth + 1);
            if (r) return r;
          }
          return null;
        }
        const found = walk(path.join(wingetBase, pkg));
        if (found) {
          const binDir = path.join(found, 'bin');
          env.PATH = binDir + ';' + env.PATH;
          env.FFMPEG_PATH = path.join(binDir, 'ffmpeg.exe');
          break;
        }
      }
    } catch {}
  }
  const llmPath = writeLlmPatch(cfg);
  if (cfg.llmMode === 'ollama') {
    const base = cfg.ollamaBase || 'http://127.0.0.1:11434/v1';
    const model = cfg.ollamaModel || 'deepseek-r1:14b';
    env.DAFY_OLLAMA_KEY = 'ollama';
    env.DSH_VISION_BASE_URL = base;
    env.DSH_VISION_API_KEY = 'ollama';
    env.DSH_VISION_MODEL = model;
  } else if (cfg.deepseekApiKey) {
    env.DEEPSEEK_API_KEY = cfg.deepseekApiKey;
    const base = cfg.deepseekBaseUrl || 'https://api.deepseek.com';
    const model = cfg.deepseekModel || 'deepseek-chat';
    env.DSH_VISION_BASE_URL = base;
    env.DSH_VISION_API_KEY = cfg.deepseekApiKey;
    env.DSH_VISION_MODEL = cfg.visionModel || 'mimo-v2.6-flash-free';
  } else if (cfg.useLocalGateway) {
    env.DAFY_GW_KEY = cfg.gatewayKey || '';
  }
  return { wlPath, llmPath, env, memCount: mem.length, memDir: path.resolve(QB, '../../..', 'Conversation_Records') };
}
function findDshBin() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  try {
    for (const d of fs.readdirSync(npxRoot)) {
      const p = path.join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(p)) candidates.push(p);
    }
  } catch (e) {}
  return candidates.find((p) => fs.existsSync(p)) || '';
}
function startBot() {
  if (child) return { ok: true, already: true };
  bindUrl = ''; qrData = ''; outBuf = ''; lines = [];
  bindHandled = false; afterBindTimer = null;
  try { fs.writeFileSync(LOG, ''); } catch (e) {}
  let prep;
  try { prep = preparePatches(); }
  catch (e) { pushLine('[bridge] prepare failed: ' + e.message); return { ok: false, error: e.message }; }
  // 出站文本变换补丁（幂等）：让人味性格层能在发送前改写文本
  try {
    const r = spawnSync(process.execPath, [path.join(QB, 'patch', 'outbound-transform.patch.js'), path.join(QB, '.dsh', 'profiles', 'qqbot')], { windowsHide: true, timeout: 15000 });
    const msg = String((r.stdout || '') + ((r.stderr || '') ? ' ' + r.stderr : '')).trim();
    if (msg) pushLine('[patch] ' + msg.split(/\r?\n/).filter(Boolean).pop());
  } catch (e) { pushLine('[patch] outbound-transform skipped: ' + e.message); }
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    cwd: QB, env: prep.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  pushLine('[bridge] memory=' + (prep.memCount || 0) + ' dir=' + prep.memDir);
  child = p; running = true;
  p.stdout.on('data', handleOutput);
  p.stderr.on('data', handleOutput);
  p.on('exit', (code) => {
    running = false;
    if (child === p) child = null;
    clearInterval(logTimer); logTimer = null;
    pushLine('[bridge] bot exited (' + code + ')');
  });
  clearInterval(logTimer);
  logTimer = setInterval(scanLog, 1000);
  return { ok: true };
}
function stopBot() {
  const p = child;
  child = null; running = false;
  clearInterval(logTimer); logTimer = null;
  if (p) {
    try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
  }
  return { ok: true };
}
// ── 记忆自动同步：大屏写入新记忆后，机器人会在空闲时重启一次载入最新记忆 ──
const memWatch = { t: 0, lastRestart: 0, timer: null };
function botLogIdleMs() {
  try { return Date.now() - fs.statSync(LOG).mtimeMs; } catch (e) { return Infinity; }
}
function startMemoryWatch() {
  const latest = memoryLatest();
  memWatch.t = latest ? latest.t : 0;
  setInterval(() => {
    const cur = memoryLatest();
    if (!cur) return;
    const changed = memWatch.t && cur.t > memWatch.t;
    memWatch.t = cur.t;
    if (!changed || !child || !running || bindUrl) return;
    if (memWatch.timer) return;
    memWatch.timer = setTimeout(function trySync() {
      memWatch.timer = null;
      if (!child || bindUrl) return;
      // 10 分钟内最多自动重启一次；正在聊天（日志 3 分钟内有动静）则等下一次
      if (Date.now() - memWatch.lastRestart < 600000) return;
      if (botLogIdleMs() < 180000) { memWatch.timer = setTimeout(trySync, 60000); return; }
      memWatch.lastRestart = Date.now();
      stopBot();
      setTimeout(startBot, 1200);
      pushLine('[memory] 检测到新记忆，已自动同步并重启机器人');
    }, 15000);
  }, 30000);
}
// ── Harness² 自进化常驻进程 ────────────────────────────────────────────
// 开启后一直运行（崩溃自动重启），只有这里的手动 stop 才会停止。
let h2Epoch = 0;
function h2Paths() {
  const cfg = readConfig();
  const dir = path.resolve(cfg.harness2Dir || path.join(QB, '..', '..', 'harness2'));
  const svc = path.join(dir, 'service');
  return {
    dir,
    exe: path.join(dir, '.venv', 'Scripts', 'python.exe'),
    script: path.join(svc, 'loop.py'),
    state: path.join(svc, 'state.json'),
    log: path.join(svc, 'service.log'),
    stop: path.join(svc, 'stop.flag'),
    pid: path.join(svc, 'service.pid')
  };
}
function h2Pid(p) {
  // uv 的 venv python.exe 是个 trampoline，spawn 返回的是父进程；
  // 真正在跑循环的是 state.json 里循环自己写的 pid。
  const cands = [];
  try {
    const st = JSON.parse(fs.readFileSync(p.state, 'utf8'));
    if (st && st.running && st.pid) cands.push(Number(st.pid));
  } catch (e) {}
  try {
    const f = Number(fs.readFileSync(p.pid, 'utf8').trim());
    if (f) cands.push(f);
  } catch (e) {}
  return cands.find((x) => x && h2Alive(x)) || cands[0] || 0;
}
function h2Alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function h2Running(p) {
  try {
    const st = JSON.parse(fs.readFileSync(p.state, 'utf8'));
    return !!(st && st.running && st.pid && h2Alive(Number(st.pid)));
  } catch (e) { return false; }
}
function h2Tail(file, n) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch (e) { return []; }
}
function h2Status() {
  const p = h2Paths();
  const pid = h2Pid(p);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(p.state, 'utf8')); } catch (e) {}
  return {
    ok: true,
    installed: fs.existsSync(p.exe) && fs.existsSync(p.script),
    running: h2Running(p),
    pid: (state && state.running && state.pid) || h2Pid(p) || null,
    dir: p.dir,
    engine: (state && state.engine) || null,
    state,
    tail: h2Tail(p.log, 80)
  };
}
function h2Start() {
  const p = h2Paths();
  if (!fs.existsSync(p.exe) || !fs.existsSync(p.script)) {
    return { ok: false, error: '没有找到 Harness² 安装：' + p.dir };
  }
  if (h2Running(p)) return { ok: true, already: true, pid: h2Pid(p) };
  fs.mkdirSync(path.dirname(p.state), { recursive: true });
  try { fs.rmSync(p.stop, { force: true }); } catch (e) {}
  h2Epoch++;
  try { fs.writeFileSync(p.log, ''); } catch (e) {}
  // 真实引擎需要的模型/网关配置全部从 config.json 下发
  const cfg = readConfig();
  const engine = cfg.harness2Engine || 'real';
  const model = cfg.harness2Model || 'dafy/mimo-v2.6-flash-free';
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    H2_ENGINE: engine,
    H2_STEPS: String(cfg.harness2Steps || 40),
    H2_ROLLOUT_STEPS: String(cfg.harness2RolloutSteps || 12),
    H2_ROLLOUT_TIMEOUT: String(cfg.harness2RolloutTimeout || 180),
    H2_ROUND_TIMEOUT: String(cfg.harness2RoundTimeout || 1800),
    H2_TASKS: String(cfg.harness2Tasks || ''),
    H2_MODE: cfg.harness2Mode || 'both',
    HARNESS2_SOLVER_MODEL: model,
    HARNESS2_IMPROVER_MODEL: cfg.harness2ImproverModel || model,
    DAFY_GW_KEY: cfg.deepseekApiKey || '',
    OPENCODE_CONFIG: path.join(p.dir, 'service', 'opencode.json'),
    PATH: path.join(p.dir, 'dependencies', 'tools', 'node_modules', '.bin') + ';' + process.env.PATH
  });
  const c = spawn(p.exe, [p.script, '--root', p.dir, '--engine', engine], {
    cwd: p.dir, detached: true, stdio: 'ignore', windowsHide: true, env
  });
  c.unref();
  try { fs.writeFileSync(p.pid, String(c.pid)); } catch (e) {}
  return { ok: true, started: true, pid: c.pid };
}
function h2Stop() {
  const p = h2Paths();
  const pid = h2Pid(p);
  if (!h2Alive(pid)) return { ok: true, already: true };
  const epoch = h2Epoch;
  // 只走手动停止这一条路径：写停止标记让循环优雅退出，超时再强制结束
  try { fs.writeFileSync(p.stop, ''); } catch (e) {}
  // 只结束这一次的进程：超时兜底必须锁定当时的 pid，不能到时再取（期间可能已被重新开启）
  setTimeout(() => {
    if (epoch !== h2Epoch) return; // 12s 内又被重新启动，兜底作废
    if (pid && h2Alive(pid)) {
      try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
    }
    try { fs.rmSync(p.stop, { force: true }); } catch (e) {}
  }, 12000);
  return { ok: true, stopping: true, pid };
}
// ── Agent Lightning 训练面板 ─────────────────────────────────────────
// 三组件：Gateway（agl-server）、Rollout Controller（agl-controller）、Trainer（verl）
// 本机显卡跑不了 verl 训练，Trainer 如实报错；Gateway/Controller 本机可跑。
function aglPaths() {
  const cfg = readConfig();
  const dir = path.resolve(cfg.aglDir || path.join(QB, '..', '..', 'agent-lightning'));
  const svc = path.join(dir, 'service');
  return {
    dir,
    svc,
    exe: path.join(dir, '.venv', 'Scripts', 'python.exe'),
    gateway: { log: path.join(svc, 'gateway.log'), pid: path.join(svc, 'gateway.pid') },
    controller: { log: path.join(svc, 'controller.log'), pid: path.join(svc, 'controller.pid') },
    trainer: { log: path.join(svc, 'trainer.log'), pid: path.join(svc, 'trainer.pid') },
    port: Number(cfg.aglGatewayPort || 8080)
  };
}
function aglAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function aglReadPid(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return n && aglAlive(n) ? n : 0;
  } catch (e) { return 0; }
}
function aglProbe(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function aglHttpJson(port, path_, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: path_, timeout: timeoutMs || 3000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function aglFetchRollouts(port) {
  // GET /api/rollouts 必须带 state_in；四种状态全查
  const q = '/api/rollouts?state_in=queuing&state_in=running&state_in=succeeded&state_in=failed&limit=500';
  const list = await aglHttpJson(port, q, 3000);
  if (!Array.isArray(list)) return null;
  const byStatus = {};
  list.forEach((r) => { const s = (r && r.status && r.status.state) || 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1; });
  // reward 曲线：取最近 20 个已结束的 rollout，逐个拉事件提取 reward
  const done = list.filter((r) => r && r.status && (r.status.state === 'succeeded' || r.status.state === 'failed'));
  const recent = done.slice(-20);
  const rewards = [];
  for (const r of recent) {
    const rid = r.rollout_id || r.id;
    if (!rid) continue;
    const evs = await aglHttpJson(port, '/api/rollouts/' + encodeURIComponent(rid) + '/events', 2000);
    if (!Array.isArray(evs)) continue;
    const rew = evs.filter((e) => e && e.event_type === 'reward' && e.payload && typeof e.payload.value === 'number');
    if (rew.length) rewards.push({ id: rid, reward: rew[rew.length - 1].payload.value });
  }
  return { total: list.length, byStatus, rewards: rewards.slice(-100) };
}
async function aglStatus() {
  const p = aglPaths();
  const cfg = readConfig();
  const gwPid = aglReadPid(p.gateway.pid);
  const ctPid = aglReadPid(p.controller.pid);
  const trPid = aglReadPid(p.trainer.pid);
  const gatewayUp = gwPid ? await aglProbe(p.port) : false;
  let rollouts = null;
  if (gatewayUp) rollouts = await aglFetchRollouts(p.port);
  return {
    ok: true,
    installed: fs.existsSync(p.exe),
    dir: p.dir,
    port: p.port,
    trainerCmd: cfg.aglTrainerCmd || '',
    gateway: { running: gatewayUp, pid: gwPid || null, tail: h2Tail(p.gateway.log, 60) },
    controller: { running: !!ctPid, pid: ctPid || null, tail: h2Tail(p.controller.log, 60) },
    trainer: { running: !!trPid, pid: trPid || null, tail: h2Tail(p.trainer.log, 60), supported: !!cfg.aglTrainerCmd },
    rollouts
  };
}
function aglSpawn(p, comp, args) {
  fs.mkdirSync(p.svc, { recursive: true });
  const f = p[comp];
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'
  });
  const fd = fs.openSync(f.log, 'a');
  const c = spawn(p.exe, args, { cwd: p.svc, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env });
  c.on('error', () => {});
  c.unref();
  try { fs.writeFileSync(f.pid, String(c.pid)); } catch (e) {}
  return c.pid;
}
function aglStartComponent(name) {
  const p = aglPaths();
  if (!fs.existsSync(p.exe)) return { ok: false, error: '没有找到 Agent Lightning 环境：' + p.dir + '（.venv 未安装）' };
  if (name === 'gateway') {
    if (aglReadPid(p.gateway.pid)) return { ok: true, already: true };
    const pid = aglSpawn(p, 'gateway', ['-m', 'agentlightning.server', 'host=127.0.0.1', 'port=' + p.port]);
    return { ok: true, started: true, pid };
  }
  if (name === 'controller') {
    if (aglReadPid(p.controller.pid)) return { ok: true, already: true };
    const pid = aglSpawn(p, 'controller', ['-m', 'agentlightning.controller', 'runner_type=local', 'agl_server.url=http://127.0.0.1:' + p.port]);
    return { ok: true, started: true, pid };
  }
  if (name === 'trainer') {
    const cfg = readConfig();
    if (!cfg.aglTrainerCmd) {
      return { ok: false, error: '本机显卡（4GB）跑不了 verl 训练。请在 config.json 配置 aglTrainerCmd 连接远程 GPU 训练后再启动。' };
    }
    if (aglReadPid(p.trainer.pid)) return { ok: true, already: true };
    // 远程/自定义训练命令：通过 cmd /c 执行用户配置的命令
    fs.mkdirSync(p.svc, { recursive: true });
    const fd = fs.openSync(p.trainer.log, 'a');
    const c = spawn('cmd.exe', ['/c', cfg.aglTrainerCmd], { cwd: p.dir, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    c.on('error', () => {});
    c.unref();
    try { fs.writeFileSync(p.trainer.pid, String(c.pid)); } catch (e) {}
    return { ok: true, started: true, pid: c.pid };
  }
  return { ok: false, error: '未知组件：' + name };
}
function aglStopComponent(name) {
  const p = aglPaths();
  const f = p[name];
  if (!f) return { ok: false, error: '未知组件：' + name };
  const pid = aglReadPid(f.pid);
  try { fs.rmSync(f.pid, { force: true }); } catch (e) {}
  if (!pid) return { ok: true, already: true };
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
  return { ok: true, stopping: true, pid };
}
async function aglStartAll() {
  const g = aglStartComponent('gateway');
  if (!g.ok) return g;
  if (!g.already) {
    // 等 gateway 就绪再拉 controller
    const p = aglPaths();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await aglProbe(p.port)) break;
    }
  }
  const c = aglStartComponent('controller');
  // 记住「已开启」状态，bridge 重启后自动拉起，免得每次重开都掉
  try { const cfg = readConfig(); cfg.aglAutoStart = true; writeConfig(cfg); } catch (e) {}
  return { ok: true, gateway: g, controller: c };
}
function aglStopAll() {
  // 先停 controller 再停 gateway
  const c = aglStopComponent('controller');
  const g = aglStopComponent('gateway');
  try { const cfg = readConfig(); cfg.aglAutoStart = false; writeConfig(cfg); } catch (e) {}
  return { ok: true, gateway: g, controller: c };
}
function status() {
  const cfg = readConfig();
  const appId = boundAppId();
  return {
    bridge: true,
    running,
    bound: !bindUrl && lines.some((l) => l.indexOf('Bot ready!') >= 0),
    qr: qrData,
    bindUrl,
    appId,
    hasCred: !!appId,
    model: cfg.llmMode === 'ollama' ? (cfg.ollamaModel || '') : (cfg.deepseekModel || ''),
    c2c: Array.isArray(cfg.c2cAllow) ? cfg.c2cAllow : [],
    group: Array.isArray(cfg.groupAllow) ? cfg.groupAllow : [],
    memCount: lastMemCount,
    proactive: {
      cfg: proactiveCfg(),
      state: loadProactiveState(),
      target: proactiveTarget(proactiveCfg())
    },
    log: lines.slice(-6)
  };
}
function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (u.pathname === '/api/health') return send(res, 200, { ok: true });
    if (u.pathname === '/api/model' && req.method === 'GET') {
      const cfg = readConfig();
      const mode = cfg.llmMode === 'ollama' ? 'ollama' : (cfg.useLocalGateway ? 'gw' : 'ds');
      const model = mode === 'ollama' ? (cfg.ollamaModel || '')
                  : mode === 'gw'      ? (cfg.gatewayModel || '')
                                       : (cfg.deepseekModel || '');
      return send(res, 200, { ok: true, mode, model, visionModel: cfg.visionModel || '' });
    }
    if (u.pathname === '/api/model' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readConfig();
      // 允许前端只传 model（当前模式下切），也可以显式传 llmMode 切模式
      if (body.llmMode) cfg.llmMode = body.llmMode;
      if (cfg.llmMode === 'ollama') {
        if (body.model) cfg.ollamaModel = body.model;
        if (body.base) cfg.ollamaBase = body.base;
      } else if (cfg.useLocalGateway) {
        if (body.model) cfg.gatewayModel = body.model;
        if (body.base) cfg.gatewayBase = body.base;
      } else {
        if (body.model) cfg.deepseekModel = body.model;
        if (body.base) cfg.deepseekBaseUrl = body.base;
      }
      if (body.visionModel) cfg.visionModel = body.visionModel;
      writeConfig(cfg);
      writeLlmPatch(cfg);
      if (running) { stopBot(); setTimeout(startBot, 1200); }
      const curModel = cfg.llmMode === 'ollama' ? (cfg.ollamaModel || '') : (cfg.deepseekModel || cfg.gatewayModel || '');
      return send(res, 200, { ok: true, mode: cfg.llmMode, model: curModel });
    }
    if (u.pathname === '/api/status') return send(res, 200, status());
    if (u.pathname === '/api/start') return send(res, 200, startBot());
    if (u.pathname === '/api/stop') return send(res, 200, stopBot());
    // ── 主动发言 ───────────────────────────────────────────────────
    if (u.pathname === '/api/proactive' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readConfig();
      const cur = cfg.proactive || {};
      cfg.proactive = {
        enabled: body.enabled != null ? !!body.enabled : !!cur.enabled,
        intervalMinutes: clampNum(body.intervalMinutes != null ? body.intervalMinutes : cur.intervalMinutes, 5, 1440, 60),
        minGapMinutes: clampNum(body.minGapMinutes != null ? body.minGapMinutes : cur.minGapMinutes, 10, 2880, 180),
        dailyLimit: clampNum(body.dailyLimit != null ? body.dailyLimit : cur.dailyLimit, 1, 20, 3),
        startHour: clampNum(body.startHour != null ? body.startHour : cur.startHour, 0, 23, 9),
        endHour: clampNum(body.endHour != null ? body.endHour : cur.endHour, 0, 24, 23),
        targetType: (body.targetType || cur.targetType) === 'group' ? 'group' : 'c2c',
        targetId: String(body.targetId != null ? body.targetId : (cur.targetId || '')),
        hint: String(body.hint != null ? body.hint : (cur.hint || '')),
        fallbackModels: Array.isArray(body.fallbackModels)
          ? body.fallbackModels.map((x) => String(x || '').trim()).filter(Boolean)
          : (Array.isArray(cur.fallbackModels) ? cur.fallbackModels : undefined)
      };
      writeConfig(cfg);
      pushLine('[主动] 设置已保存：' + (cfg.proactive.enabled ? '已开启' : '已关闭'));
      return send(res, 200, { ok: true, cfg: proactiveCfg() });
    }
    if (u.pathname === '/api/proactive/test' && req.method === 'POST') {
      return send(res, 200, await proactiveTick(true));
    }
    // ── Harness² 自进化 ────────────────────────────────────────────
    if (u.pathname === '/api/harness2/status') return send(res, 200, h2Status());
    if (u.pathname === '/api/harness2/start' && req.method === 'POST') return send(res, 200, h2Start());
    if (u.pathname === '/api/harness2/stop' && req.method === 'POST') return send(res, 200, h2Stop());
    // ── Agent Lightning ────────────────────────────────────────────
    if (u.pathname === '/api/agl/status') return send(res, 200, await aglStatus());
    if (u.pathname === '/api/agl/start' && req.method === 'POST') return send(res, 200, await aglStartAll());
    if (u.pathname === '/api/agl/stop' && req.method === 'POST') return send(res, 200, aglStopAll());
    const aglComp = u.pathname.match(/^\/api\/agl\/component\/(gateway|controller|trainer)\/(start|stop)$/);
    if (aglComp && req.method === 'POST') {
      return send(res, 200, aglComp[2] === 'start' ? aglStartComponent(aglComp[1]) : aglStopComponent(aglComp[1]));
    }
    // ── ChatTTS 语音合成 ────────────────────────────────────────────
    if (u.pathname === '/api/tts/status') return send(res, 200, await ttsStatus());
    if (u.pathname === '/api/tts/start' && req.method === 'POST') return send(res, 200, await ttsStart());
    if (u.pathname === '/api/tts/stop' && req.method === 'POST') return send(res, 200, await ttsStop());
    // 透传到 tts_server.py（synthesize/voices/clone/health）
    if (u.pathname.startsWith('/api/tts/')) {
      // synthesize 之前先确保服务在跑
      if (!ttsProc && u.pathname !== '/api/tts/status' && u.pathname !== '/api/tts/start') {
        const ok = await ttsProbe(500);
        if (!ok) await ttsStart();
      }
      return ttsProxy(u, req, res);
    }
    // ── Edge-TTS 语音合成（快速版）────────────────────────────────────
    if (u.pathname === '/api/tts2/status') return send(res, 200, await edgeTtsStatus());
    if (u.pathname === '/api/tts2/start' && req.method === 'POST') return send(res, 200, await edgeTtsStart());
    if (u.pathname === '/api/tts2/stop' && req.method === 'POST') return send(res, 200, await edgeTtsStop());
    // ── TTS 语音缓存管理（统计/删除）─────────────────────────────────
    if (u.pathname === '/api/tts-cache') return send(res, 200, ttsCacheInfo());
    if (u.pathname === '/api/tts-cache/clear' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, ttsCacheClear(b));
    }
    // 透传到 edge_tts_server.py
    if (u.pathname.startsWith('/api/tts2/')) {
      if (!edgeTtsProc && u.pathname !== '/api/tts2/status' && u.pathname !== '/api/tts2/start') {
        const ok = await edgeTtsProbe(500);
        if (!ok) await edgeTtsStart();
      }
      return edgeTtsProxy(u, req, res);
    }
    if (u.pathname === '/api/rebind' && req.method === 'POST') {
      stopBot();
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        if (fs.existsSync(PROFILE_PATCH)) fs.copyFileSync(PROFILE_PATCH, PROFILE_PATCH + '.bak-' + ts);
        fs.writeFileSync(PROFILE_PATCH, '[]\n', 'utf8');
        const cfg = readConfig();
        cfg.discover = true;
        writeConfig(cfg);
      } catch (e) {}
      setTimeout(startBot, 1200);
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/open-group' && req.method === 'POST') {
      const cfg = readConfig();
      cfg.groupOpen = true;
      writeConfig(cfg);
      if (child) { stopBot(); setTimeout(startBot, 1200); }
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/open-bind' && req.method === 'POST') {
      stopBot();
      try {
        spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath ".\\start-qqbot.cmd"'], {
          cwd: QB, detached: true, stdio: 'ignore', windowsHide: false
        }).unref();
      } catch (e) {}
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/whitelist' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = readConfig();
      const clean = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []);
      const wasRunning = !!child;
      cfg.c2cAllow = clean(b.c2c);
      cfg.groupAllow = clean(b.group);
      cfg.discover = false;
      cfg.groupOpen = false;
      writeConfig(cfg);
      if (wasRunning) { stopBot(); setTimeout(startBot, 1200); }
      return send(res, 200, { ok: true, restarting: wasRunning });
    }
    if (u.pathname === '/api/memory-sync' && req.method === 'POST') {
      let mem;
      try { mem = loadSharedMemory(); } catch (e) { return send(res, 500, { error: e.message }); }
      const wasRunning = !!child;
      if (wasRunning) { stopBot(); setTimeout(startBot, 1200); }
      pushLine('[memory] 手动同步：' + mem.length + ' 条记忆' + (wasRunning ? '，机器人重启中' : ''));
      return send(res, 200, { ok: true, restarting: wasRunning, memCount: mem.length, memDir: path.resolve(QB, '../../..', 'Conversation_Records') });
    }
    // ── 人味插件 fish-tone 配置 ──────────────────────────────────────
    const FISH_MAIN = path.join(QB, 'plugins', 'dsh-fish-tone', 'packages', 'dsh-fish-tone', 'config.json');
    const FISH_FLAVOR = path.join(QB, 'plugins', 'dsh-fish-tone', 'packages', 'dsh-fish-tone-flavor', 'config.json');
    const FISH_MAIN_DEFAULTS = { enabled: true, strength: 'light', seed: 7, grammar: true, marks: 'light' };
    const FISH_FLAVOR_DEFAULTS = { enabled: false, mode: 'cute', rate: 'low', seed: 7 };
    const readJson = (p, def) => { try { return { ...def, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return { ...def }; } };
    if (u.pathname === '/api/fish-tone' && req.method === 'GET') {
      return send(res, 200, { main: readJson(FISH_MAIN, FISH_MAIN_DEFAULTS), flavor: readJson(FISH_FLAVOR, FISH_FLAVOR_DEFAULTS) });
    }
    if (u.pathname === '/api/fish-tone' && req.method === 'POST') {
      const b = await readBody(req);
      const oneOf = (v, set, def) => (set.indexOf(v) >= 0 ? v : def);
      const num = (v, def) => (Number.isFinite(v) ? v : def);
      const main = {
        enabled: b.main && typeof b.main.enabled === 'boolean' ? b.main.enabled : FISH_MAIN_DEFAULTS.enabled,
        strength: oneOf(b.main && b.main.strength, ['off', 'light', 'normal', 'max'], FISH_MAIN_DEFAULTS.strength),
        seed: num(b.main && b.main.seed, FISH_MAIN_DEFAULTS.seed),
        grammar: b.main && typeof b.main.grammar === 'boolean' ? b.main.grammar : FISH_MAIN_DEFAULTS.grammar,
        marks: oneOf(b.main && b.main.marks, ['off', 'light', 'normal', 'max'], FISH_MAIN_DEFAULTS.marks),
      };
      const flavor = {
        enabled: b.flavor && typeof b.flavor.enabled === 'boolean' ? b.flavor.enabled : FISH_FLAVOR_DEFAULTS.enabled,
        mode: oneOf(b.flavor && b.flavor.mode, ['cute', 'abstract'], FISH_FLAVOR_DEFAULTS.mode),
        rate: oneOf(b.flavor && b.flavor.rate, ['low', 'normal', 'high'], FISH_FLAVOR_DEFAULTS.rate),
        seed: num(b.flavor && b.flavor.seed, FISH_FLAVOR_DEFAULTS.seed),
      };
      fs.writeFileSync(FISH_MAIN, JSON.stringify(main, null, 2) + '\n', 'utf8');
      fs.writeFileSync(FISH_FLAVOR, JSON.stringify(flavor, null, 2) + '\n', 'utf8');
      const wasRunning = !!child;
      if (wasRunning) { stopBot(); setTimeout(startBot, 1200); }
      return send(res, 200, { ok: true, restarting: wasRunning, main, flavor });
    }
    // ── 人味插件 · 学习进度 ──────────────────────────────────────────
    const FISH_STYLE = path.join(QB, 'plugins', 'dsh-fish-tone', 'packages', 'dsh-fish-tone-flavor', 'style-profile.json');
    if (u.pathname === '/api/fish-tone/style' && req.method === 'GET') {
      let st = null;
      try { st = JSON.parse(fs.readFileSync(FISH_STYLE, 'utf8')); } catch (e) {}
      if (!st) return send(res, 200, { ok: true, learning: false, samples: 0, recent: [] });
      const top = (o, n) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
      return send(res, 200, {
        ok: true,
        learning: (st.samples || 0) >= 5,
        samples: st.samples || 0,
        avgLen: st.samples ? Math.round((st.totalLen || 0) / st.samples) : 0,
        particles: top(st.particles, 5),
        words: top(st.words, 8),
        punct: st.punct || {},
        recent: (st.recent || []).slice(-8),
        updatedAt: st.updatedAt || ''
      });
    }
    if (u.pathname === '/api/fish-tone/style' && req.method === 'POST') {
      // 清空学习记录，重新学
      try { fs.writeFileSync(FISH_STYLE, JSON.stringify({ samples: 0, totalLen: 0, particles: {}, punct: { '!': 0, '?': 0, '~': 0, '…': 0 }, words: {}, recent: [], updatedAt: '' }, null, 2) + '\n', 'utf8'); } catch (e) {}
      return send(res, 200, { ok: true });
    }
    // ── 定时任务 scheduled-tasks ──────────────────────────────────────
    if (u.pathname === '/api/scheduled-tasks' && req.method === 'GET') {
      return send(res, 200, { tasks: loadScheduledTasks() });
    }
    if (u.pathname === '/api/scheduled-tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const tasks = loadScheduledTasks();
      const now = Date.now();
      const interval = Math.max(1, parseInt(b.intervalMinutes, 10) || 60);
      const clampHour = (v, def) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n >= 0 && n <= 23) ? n : def; };
      const task = {
        id: 't_' + now.toString(36) + Math.random().toString(36).slice(2, 7),
        name: String(b.name || '未命名任务').slice(0, 50),
        enabled: b.enabled !== false,
        targetType: b.targetType === 'group' ? 'group' : 'c2c',
        targetId: String(b.targetId || '').trim(),
        content: String(b.content || ''),
        intervalMinutes: interval,
        startHour: clampHour(b.startHour, 8),
        endHour: clampHour(b.endHour, 23),
        nextRun: b.nextRun || new Date(now + interval * 60000).toISOString(),
        lastRun: null,
      };
      if (!task.targetId || !task.content) return send(res, 400, { error: 'targetId 和 content 必填' });
      tasks.push(task);
      saveScheduledTasks(tasks);
      return send(res, 200, { ok: true, task });
    }
    // /api/scheduled-tasks/:id  (PUT / DELETE)  和  /api/scheduled-tasks/:id/run (POST)
    const stm = u.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)(?:\/(run))?$/);
    if (stm) {
      const id = decodeURIComponent(stm[1]);
      const sub = stm[2];
      const tasks = loadScheduledTasks();
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx < 0) return send(res, 404, { error: 'task not found' });
      if (sub === 'run' && req.method === 'POST') {
        const r = await runScheduledTask(tasks[idx]);
        if (r.ok) {
          tasks[idx].lastRun = new Date().toISOString();
          saveScheduledTasks(tasks);
        }
        return send(res, 200, r);
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const t = tasks[idx];
        const clampHour = (v, def) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n >= 0 && n <= 23) ? n : def; };
        if (b.name !== undefined) t.name = String(b.name).slice(0, 50);
        if (b.enabled !== undefined) t.enabled = !!b.enabled;
        if (b.targetType !== undefined) t.targetType = b.targetType === 'group' ? 'group' : 'c2c';
        if (b.targetId !== undefined) t.targetId = String(b.targetId).trim();
        if (b.content !== undefined) t.content = String(b.content);
        if (b.intervalMinutes !== undefined) t.intervalMinutes = Math.max(1, parseInt(b.intervalMinutes, 10) || 60);
        if (b.startHour !== undefined) t.startHour = clampHour(b.startHour, t.startHour ?? 8);
        if (b.endHour !== undefined) t.endHour = clampHour(b.endHour, t.endHour ?? 23);
        if (b.nextRun !== undefined) t.nextRun = b.nextRun;
        saveScheduledTasks(tasks);
        return send(res, 200, { ok: true, task: t });
      }
      if (req.method === 'DELETE') {
        tasks.splice(idx, 1);
        saveScheduledTasks(tasks);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);
  process.exit(1);
});
// 本机 Ollama 转发代理（11435 → 11434）
// Ollama 的 /v1 接口不认 think 参数，R1 会先输出一大段"思考"，4GB 显存下要等好几分钟。
// 这里把 OpenAI 请求转成 Ollama 原生 /api/chat（带 think:false），再把响应转回 OpenAI 格式。
let ollProxy = null;
function startOllProxy() {
  if (ollProxy) return;
  const TARGET = { host: '127.0.0.1', port: 11434 };
  function passThrough(req, res) {
    const headers = Object.assign({}, req.headers);
    delete headers.host;
    const up = http.request(Object.assign({ method: req.method, path: req.url, headers }, TARGET), (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (e) => {
      try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'ollama proxy: ' + e.message } })); } catch (x) {}
    });
    req.pipe(up);
  }
  function toOllama(body) {
    const msgs = Array.isArray(body.messages) ? body.messages.map((m) => {
      let c = m.content;
      if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
      return { role: m.role === 'developer' ? 'system' : m.role, content: String(c == null ? '' : c) };
    }) : [];
    const opt = {};
    const mt = Number(body.max_tokens);
    if (mt > 0) opt.num_predict = Math.min(mt, 400);
    if (typeof body.temperature === 'number') opt.temperature = body.temperature;
    // R1-Distill 不支持 think 参数，只能在提示里要求它不要展开推理
    const direct = '直接给出最终回答，不要描述你的分析或思考过程，用简短自然的口语。';
    if (msgs.length && msgs[0].role === 'system') msgs[0].content += '\n' + direct;
    else msgs.unshift({ role: 'system', content: direct });
    const out = { model: body.model || 'deepseek-r1:14b', messages: msgs, stream: !!body.stream, think: false, options: opt };
    if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools;
    return out;
  }
  function handleChat(req, res) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return res.writeHead(400).end(); }
      const oll = toOllama(body || {});
      const payload = JSON.stringify(oll);
      const up = http.request({
        host: TARGET.host, port: TARGET.port, method: 'POST', path: '/api/chat',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }
      }, (ur) => {
        const id = 'chatcmpl-' + Date.now();
        const created = Math.floor(Date.now() / 1000);
        const model = oll.model;
        if (ur.statusCode !== 200) {
          let b = '';
          ur.on('data', (c) => { b += c; });
          ur.on('end', () => {
            try { res.writeHead(ur.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: b || ('ollama ' + ur.statusCode), type: 'ollama_error' } })); } catch (x) {}
          });
          return;
        }
        if (!oll.stream) {
          let b = '';
          ur.on('data', (c) => { b += c; });
          ur.on('end', () => {
            let j = {};
            try { j = JSON.parse(b); } catch (e) {}
            const m = j.message || {};
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                id, object: 'chat.completion', created, model,
                choices: [{ index: 0, message: { role: 'assistant', content: m.content || m.thinking || '' }, finish_reason: j.done_reason || 'stop' }],
                usage: { prompt_tokens: j.prompt_eval_count || 0, completion_tokens: j.eval_count || 0, total_tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0) }
              }));
            } catch (x) {}
          });
          return;
        }
        try {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        } catch (x) { return; }
        const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (x) {} };
        let buf = '';
        ur.setEncoding('utf8');
        ur.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split('\n');
          buf = parts.pop();
          for (const line of parts) {
            const t = line.trim();
            if (!t) continue;
            let j; try { j = JSON.parse(t); } catch (e) { continue; }
            if (j.message && (j.message.content || j.message.thinking)) {
              send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: j.message.content || j.message.thinking }, finish_reason: null }] });
            }
            if (j.done) {
              send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: j.done_reason || 'stop' }],
                usage: { prompt_tokens: j.prompt_eval_count || 0, completion_tokens: j.eval_count || 0, total_tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0) } });
            }
          }
        });
        ur.on('end', () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch (x) {} });
        ur.on('error', () => { try { res.end(); } catch (x) {} });
      });
      up.on('error', (e) => {
        try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'ollama proxy: ' + e.message } })); } catch (x) {}
      });
      up.end(payload);
    });
  }
  ollProxy = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/v1/chat/completions') return handleChat(req, res);
    passThrough(req, res);
  });
  ollProxy.on('error', (e) => pushLine('[oll-proxy] ' + e.message));
  ollProxy.listen(11435, '127.0.0.1', () => pushLine('[oll-proxy] 127.0.0.1:11435 → 11434（think=false）'));
}
// 本地转发服务（18900）没开时自动拉起，免得 QQ 因为没有模型可用而不回复
function startOfm() {
  const dir = path.resolve(QB, '..', '..', 'dsh-our-free-model');
  const cli = path.join(dir, 'packages', 'standalone', 'cli.mjs');
  if (!fs.existsSync(cli)) return;
  pushLine('[ofm] 18900 未运行，正在启动本地转发服务');
  try {
    const p = spawn(process.execPath, [cli, '--port', '18900'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
  } catch (e) { pushLine('[ofm] 启动失败: ' + e.message); }
}
function ensureOfm() {
  const cfg = readConfig();
  if (cfg.llmMode === 'ollama') return;
  const base = String(cfg.deepseekBaseUrl || '');
  if (base.indexOf('127.0.0.1:18900') < 0) return;
  const req = http.request({
    host: '127.0.0.1', port: 18900, path: '/v1/models', method: 'GET', timeout: 2000,
    headers: { Authorization: 'Bearer ' + (cfg.deepseekApiKey || '') }
  }, (r) => { r.resume(); });
  req.on('error', () => startOfm());
  req.on('timeout', () => { req.destroy(); startOfm(); });
  req.end();
}
// ── ChatTTS 语音合成守护 ────────────────────────────────────────────
const TTS_PORT = 18903;
const TTS_DIR = path.resolve(QB, '..', 'tts');
// Python 解析顺序：环境变量 → 安装目录自带 python → 开发机 venv → PATH
function resolvePython() {
  const cands = [];
  if (process.env.DAFY_PYTHON) cands.push(process.env.DAFY_PYTHON);
  cands.push(path.resolve(QB, '..', 'python', 'python.exe'));
  cands.push(path.resolve(QB, '..', '..', 'agent-lightning', '.venv', 'Scripts', 'python.exe'));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'python';
}
const TTS_PY = resolvePython();
const TTS_SCRIPT = path.join(TTS_DIR, 'tts_server.py');
let ttsProc = null;

function ttsInstalled() {
  const pyOk = TTS_PY === 'python' || fs.existsSync(TTS_PY);
  return pyOk && fs.existsSync(TTS_SCRIPT);
}
function ttsProbe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: TTS_PORT, path: '/health', timeout: timeoutMs }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.ok === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
function ttsStatus() {
  return new Promise((resolve) => {
    if (!ttsInstalled()) return resolve({ ok: true, installed: false, running: false, error: '未安装' });
    ttsProbe(2000).then((ok) => resolve({
      ok: true, installed: true, running: ok, port: TTS_PORT,
      py: TTS_PY, script: TTS_SCRIPT,
    }));
  });
}
function ttsStart() {
  return new Promise((resolve) => {
    if (!ttsInstalled()) return resolve({ ok: false, error: '没找到 python 或 tts_server.py' });
    ttsProbe(800).then((already) => {
      if (already) return resolve({ ok: true, already: true });
      const cfg = readConfig();
      const fd = fs.openSync(path.join(TTS_DIR, 'tts.log'), 'a');
      const env = Object.assign({}, process.env, {
        PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
        CUDA_VISIBLE_DEVICES: '',
        HF_ENDPOINT: 'https://hf-mirror.com',
      });
      try {
        ttsProc = spawn(TTS_PY, [TTS_SCRIPT, '--port', String(TTS_PORT), '--preload'], {
          cwd: TTS_DIR, env, windowsHide: true, detached: true, stdio: ['ignore', fd, fd]
        });
        ttsProc.on('exit', () => { pushLine('[tts] 进程已退出'); ttsProc = null; });
        ttsProc.on('error', (e) => { pushLine('[tts] 启动失败: ' + e.message); });
        ttsProc.unref();
      } catch (e) { return resolve({ ok: false, error: e.message }); }
      // 等最多 30s 让模型加载完
      let waited = 0;
      const tick = () => {
        ttsProbe(500).then((ok) => {
          if (ok) return resolve({ ok: true, pid: ttsProc ? ttsProc.pid : null });
          waited += 500;
          if (waited > 60000) return resolve({ ok: false, error: '启动超时（模型加载慢？看 tts/tts.log）' });
          setTimeout(tick, 1000);
        });
      };
      setTimeout(tick, 2000);
    });
  });
}
function ttsStop() {
  return new Promise((resolve) => {
    const p = ttsProc; ttsProc = null;
    // 用 taskkill 杀所有子进程（tts_server.py 可能 spawn 其他）
    try { spawn('taskkill', ['/F', '/IM', 'python.exe', '/FI', `WINDOWTITLE eq ${TTS_SCRIPT}`], { windowsHide: true }); } catch {}
    // 更精确：直接杀端口
    const netstat = spawn('netstat', ['-ano'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    netstat.stdout.on('data', (c) => buf += c);
    netstat.on('exit', () => {
      const lines = buf.split(/\r?\n/).filter((l) => l.indexOf(':' + TTS_PORT) >= 0 && l.indexOf('LISTENING') >= 0);
      for (const l of lines) {
        const m = l.trim().split(/\s+/);
        const pid = parseInt(m[m.length - 1], 10);
        if (pid && pid !== 0) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {} }
      }
      resolve({ ok: true });
    });
  });
}
// 转发到 tts_server：把 /api/tts/synthesize → http://127.0.0.1:18903/synthesize
function ttsProxy(u, req, res) {
  const sub = u.pathname.replace(/^\/api\/tts/, ''); // /synthesize /voices /health
  const targetPath = sub || '/health';
  const opts = { host: '127.0.0.1', port: TTS_PORT, path: targetPath + (u.search || ''), method: req.method, headers: req.headers };
  const up = http.request(opts, (ur) => {
    const headers = Object.assign({}, ur.headers);
    delete headers.connection;
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    res.writeHead(ur.statusCode || 502, headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'tts: ' + e.message })); } catch (x) {}
  });
  req.pipe(up);
}

// ── Edge-TTS 语音合成守护 ────────────────────────────────────────────
const EDGE_TTS_PORT = 18904;
const EDGE_TTS_SCRIPT = path.join(TTS_DIR, 'edge_tts_server.py');
let edgeTtsProc = null;

function edgeTtsInstalled() {
  const pyOk = TTS_PY === 'python' || fs.existsSync(TTS_PY);
  return pyOk && fs.existsSync(EDGE_TTS_SCRIPT);
}
function edgeTtsProbe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: EDGE_TTS_PORT, path: '/health', timeout: timeoutMs }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.ok === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
function edgeTtsStatus() {
  return new Promise((resolve) => {
    if (!edgeTtsInstalled()) return resolve({ ok: true, installed: false, running: false, error: '未安装' });
    edgeTtsProbe(2000).then((ok) => resolve({
      ok: true, installed: true, running: ok, port: EDGE_TTS_PORT,
      py: TTS_PY, script: EDGE_TTS_SCRIPT,
    }));
  });
}
function edgeTtsStart() {
  return new Promise((resolve) => {
    if (!edgeTtsInstalled()) return resolve({ ok: false, error: '没找到 python 或 edge_tts_server.py' });
    edgeTtsProbe(800).then((already) => {
      if (already) return resolve({ ok: true, already: true });
      const fd = fs.openSync(path.join(TTS_DIR, 'edge_tts.log'), 'a');
      const env = Object.assign({}, process.env, {
        PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      });
      try {
        edgeTtsProc = spawn(TTS_PY, [EDGE_TTS_SCRIPT, '--port', String(EDGE_TTS_PORT)], {
          cwd: TTS_DIR, env, windowsHide: true, detached: true, stdio: ['ignore', fd, fd]
        });
        edgeTtsProc.on('exit', () => { pushLine('[edge-tts] 进程已退出'); edgeTtsProc = null; });
        edgeTtsProc.on('error', (e) => { pushLine('[edge-tts] 启动失败: ' + e.message); });
        edgeTtsProc.unref();
      } catch (e) { return resolve({ ok: false, error: e.message }); }
      // Edge-TTS 启动很快，等 5s 即可
      let waited = 0;
      const tick = () => {
        edgeTtsProbe(500).then((ok) => {
          if (ok) return resolve({ ok: true, pid: edgeTtsProc ? edgeTtsProc.pid : null });
          waited += 500;
          if (waited > 10000) return resolve({ ok: false, error: '启动超时' });
          setTimeout(tick, 500);
        });
      };
      setTimeout(tick, 1000);
    });
  });
}
function edgeTtsStop() {
  return new Promise((resolve) => {
    const p = edgeTtsProc; edgeTtsProc = null;
    const netstat = spawn('netstat', ['-ano'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    netstat.stdout.on('data', (c) => buf += c);
    netstat.on('exit', () => {
      const lines = buf.split(/\r?\n/).filter((l) => l.indexOf(':' + EDGE_TTS_PORT) >= 0 && l.indexOf('LISTENING') >= 0);
      for (const l of lines) {
        const m = l.trim().split(/\s+/);
        const pid = parseInt(m[m.length - 1], 10);
        if (pid && pid !== 0) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {} }
      }
      resolve({ ok: true });
    });
  });
}
// 转发到 edge_tts_server：把 /api/tts2/synthesize → http://127.0.0.1:18904/synthesize
function edgeTtsProxy(u, req, res) {
  const sub = u.pathname.replace(/^\/api\/tts2/, ''); // /synthesize /voices /health
  const targetPath = sub || '/health';
  const opts = { host: '127.0.0.1', port: EDGE_TTS_PORT, path: targetPath + (u.search || ''), method: req.method, headers: req.headers };
  const up = http.request(opts, (ur) => {
    const headers = Object.assign({}, ur.headers);
    delete headers.connection;
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    res.writeHead(ur.statusCode || 502, headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'edge-tts: ' + e.message })); } catch (x) {}
  });
  req.pipe(up);
}

// ── TTS 语音缓存管理 ─────────────────────────────────────────────
// Edge-TTS 缓存在 tts/cache_edge/*.mp3，ChatTTS 缓存在 tts/cache/*.wav
const TTS_CACHE_DIRS = {
  edge: path.join(TTS_DIR, 'cache_edge'),
  chattts: path.join(TTS_DIR, 'cache'),
};
function ttsCacheInfo() {
  const out = { ok: true, total: { count: 0, bytes: 0 } };
  for (const k of Object.keys(TTS_CACHE_DIRS)) {
    const dir = TTS_CACHE_DIRS[k];
    const files = [];
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(mp3|wav)$/i.test(name)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          bytes += st.size;
          files.push({ name, size: st.size, mtime: st.mtimeMs });
        } catch (e) {}
      }
    } catch (e) {}
    files.sort((a, b) => b.mtime - a.mtime);
    out[k] = { dir, count: files.length, bytes, files: files.slice(0, 300) };
    out.total.count += files.length;
    out.total.bytes += bytes;
  }
  return out;
}
function ttsCacheClear(b) {
  const engine = (b && b.engine) || 'all';
  const file = String((b && b.file) || '');
  const keys = engine === 'all' ? Object.keys(TTS_CACHE_DIRS) : [engine];
  let removed = 0, freed = 0, errors = 0;
  for (const k of keys) {
    const dir = TTS_CACHE_DIRS[k];
    if (!dir) { errors++; continue; }
    if (file) {
      // 单个删除：basename 校验防路径穿越
      const safe = path.basename(file);
      if (safe !== file || !/\.(mp3|wav)$/i.test(safe)) { errors++; continue; }
      try {
        const fp = path.join(dir, safe);
        freed += fs.statSync(fp).size;
        fs.unlinkSync(fp);
        removed++;
      } catch (e) { errors++; }
      continue;
    }
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(mp3|wav)$/i.test(name)) continue;
        try {
          const fp = path.join(dir, name);
          freed += fs.statSync(fp).size;
          fs.unlinkSync(fp);
          removed++;
        } catch (e) { errors++; }
      }
    } catch (e) {}
  }
  pushLine('[tts-cache] 清理语音缓存 ' + removed + ' 个，释放 ' + (freed / 1048576).toFixed(1) + ' MB');
  return { ok: errors === 0, removed, freed, errors };
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('[bridge] listening on http://127.0.0.1:' + PORT);
  const cfg = readConfig();
  try { startOllProxy(); } catch (e) {}
  try { ensureOfm(); } catch (e) {}
  if (cfg.autoStart !== false) setTimeout(startBot, 800);
  startScheduler();
  startProactive();
  startMemoryWatch();
  // AGL 自动拉起（用户在大屏开过「全部启动」后，bridge 重启自动恢复）
  if (cfg.aglAutoStart) {
    aglStartAll().then((r) => pushLine(r.ok ? '[agl] 已按上次状态自动启动' : '[agl] 自动启动失败: ' + (r.error || '')));
  }
  // TTS 自动启动（如果装了 ChatTTS 且 config 没关）
  if (cfg.tts && cfg.tts.enabled !== false && ttsInstalled()) {
    ttsStart().then((r) => pushLine(r.ok ? '[tts] 语音合成服务已启动' : '[tts] 自动启动失败: ' + (r.error || '')));
  }
  // Edge-TTS 自动启动（默认启用）
  if (edgeTtsInstalled()) {
    edgeTtsStart().then((r) => pushLine(r.ok ? '[edge-tts] 语音合成服务已启动' : '[edge-tts] 自动启动失败: ' + (r.error || '')));
  }
});
