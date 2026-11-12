// keep_alive.js —— 守护 bridge + tts_server 并保活
// 用法: node keep_alive.js
// 这个脚本会一直跑，两个子进程都 detached，
// 就算这个脚本被杀，子进程也不会死（Windows 特性）
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const QB = path.resolve(__dirname, 'qqbot');
const BRIDGE = path.join(QB, 'bridge', 'bridge.js');
// Python 解析顺序：环境变量 → 安装目录自带 python → 开发机 venv → PATH
function resolvePython() {
  const cands = [];
  if (process.env.DAFY_PYTHON) cands.push(process.env.DAFY_PYTHON);
  cands.push(path.join(__dirname, 'python', 'python.exe'));
  cands.push(path.resolve(__dirname, '..', 'agent-lightning', '.venv', 'Scripts', 'python.exe'));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'python';
}
const TTS_PY = resolvePython();
const TTS_SCRIPT = path.join(__dirname, 'tts', 'tts_server.py');
const TTS_DIR = path.join(__dirname, 'tts');
const TTS_PORT = 18903;
const EDGE_TTS_PORT = 18904;
const BRIDGE_PORT = 18902;
const OFM_PORT = 18900;          // 本地免费模型网关（dsh-our-free-model）
const OFM_DIR = path.resolve(__dirname, '..', 'dsh-our-free-model');
const OFM_CLI = path.join(OFM_DIR, 'packages', 'standalone', 'cli.mjs');
const PC_PORT = 18907;           // 电脑控制服务（截屏 / OCR / 键鼠）
const PC_DIR = path.join(__dirname, 'pc-server');
const PC_SCRIPT = path.join(PC_DIR, 'server.js');
const VIDEO_PORT = 18905;        // 视频 / 文件服务（大屏的文件夹、删除、抖音工具）
const VIDEO_DIR = path.join(__dirname, 'video-server');
const VIDEO_SCRIPT = path.join(VIDEO_DIR, 'server.js');
const NODE = process.execPath;   // 直接用当前运行的 node，避免硬编码路径

// bridge 的健康接口是 /api/health，TTS 两个服务是 /health
const BRIDGE_HEALTH = '/api/health';

// 网关 /v1/models 要鉴权：任意 HTTP 响应（含 401）都算活着
function probePort(port, timeout = 1000) {
  return new Promise((ok) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/', timeout }, (res) => { res.resume(); ok(true); });
    r.on('error', () => ok(false)).on('timeout', () => { r.destroy(); ok(false); });
  });
}
function startOfm() {
  if (!fs.existsSync(OFM_CLI)) { console.log('[ofm] 未找到 dsh-our-free-model，跳过'); return; }
  console.log('启动本地模型网关（18900）...');
  spawnDetached(NODE, [OFM_CLI, '--port', String(OFM_PORT)], { cwd: OFM_DIR, name: 'ofm' });
}

function probe(port, timeout = 1000, healthPath = '/health') {
  return new Promise((ok) => {
    http.get({ host: '127.0.0.1', port, path: healthPath, timeout }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { ok(JSON.parse(d).ok === true) } catch { ok(false) } });
    }).on('error', () => ok(false)).on('timeout', () => ok(false));
  });
}

function spawnDetached(cmd, args, opts = {}) {
  // 确保 PATH 不被覆盖（cmd 里可能没有）
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    CUDA_VISIBLE_DEVICES: '', HF_ENDPOINT: 'https://hf-mirror.com',
  }, opts.env || {});
  // shell=true 时含空格的路径（如 C:\Program Files\...）必须加引号
  const cmdStr = /\s/.test(cmd) && !/^".*"$/.test(cmd) ? '"' + cmd + '"' : cmd;
  const p = spawn(cmdStr, args, Object.assign({
    detached: true, windowsHide: false, shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }, opts, { env }));
  p.stdout.on('data', c => process.stdout.write(`[${opts.name||cmd}] ${c.toString().trim()}\n`));
  p.stderr.on('data', c => process.stdout.write(`[${opts.name||cmd}-err] ${c.toString().trim()}\n`));
  p.on('exit', code => console.log(`[${opts.name||cmd}] exited code=${code}`));
  p.on('error', e => console.log(`[${opts.name||cmd}] error ${e.message}`));
  p.unref();
  return p;
}

async function main() {
  console.log('=== 大肥鱼 TTS + Bridge 守护启动 ===');

  // 1. 先检查端口
  const ttsOk = await probe(TTS_PORT, 500);
  const brOk = await probe(BRIDGE_PORT, 500, BRIDGE_HEALTH);
  console.log(`端口检测: bridge=${brOk?'运行中':'空闲'}, tts=${ttsOk?'运行中':'空闲'}`);

  // 2. 启 bridge（如果没在跑）
  if (!brOk) {
    console.log('启动 bridge...');
    spawnDetached(NODE, [BRIDGE], { cwd: QB, name: 'bridge', windowsHide: false });
  }

  // 3. 等 bridge 起来
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await probe(BRIDGE_PORT, 500, BRIDGE_HEALTH)) { console.log('bridge 已就绪'); break; }
  }

  // 4. 启 TTS（如果没在跑）
  if (!ttsOk) {
    console.log('启动 tts_server（首次 preload 约 55s）...');
    spawnDetached(TTS_PY, [TTS_SCRIPT, '--port', String(TTS_PORT), '--preload'], {
      cwd: TTS_DIR, name: 'tts', windowsHide: false,
    });
  }

  // 4.5 启 Edge-TTS（如果没在跑）
  const edgeOk = await probe(EDGE_TTS_PORT, 500);
  if (!edgeOk) {
    console.log('启动 edge_tts_server（秒级启动）...');
    spawnDetached(TTS_PY, [path.join(TTS_DIR, 'edge_tts_server.py'), '--port', String(EDGE_TTS_PORT)], {
      cwd: TTS_DIR, name: 'edge-tts', windowsHide: false,
    });
  }

  // 5. 等 TTS preload 完成
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const h = await probe(TTS_PORT, 500);
    process.stdout.write(h ? `✓ tts 已就绪 (${i+1}s)\n` : `⏳ 等待 tts ${i+1}s...\r`);
    if (h) break;
  }

  // 5.5 启本地模型网关（如果没在跑）——机器人没它就不回复
  if (!(await probePort(OFM_PORT, 800))) startOfm();

  // 5.6 启电脑控制服务（截屏 / OCR / 键鼠），大屏 AI 靠它看屏幕
  if (!(await probePort(PC_PORT, 500))) {
    console.log('启动 电脑控制服务 18907...');
    spawnDetached(NODE, [PC_SCRIPT], { cwd: PC_DIR, name: 'pc', windowsHide: true });
  }

  // 5.7 启视频/文件服务（18905），大屏的文件管理、删除、抖音工具都靠它
  if (!(await probePort(VIDEO_PORT, 500))) {
    console.log('启动 视频/文件服务 18905...');
    spawnDetached(NODE, [VIDEO_SCRIPT], { cwd: VIDEO_DIR, name: 'video', windowsHide: true });
  }

  // 6. 打印最终状态
  console.log('\n=== 服务状态 ===');
  const f0 = await probePort(OFM_PORT, 1000);
  const f1 = await probe(BRIDGE_PORT, 1000, BRIDGE_HEALTH);
  const f2 = await probe(TTS_PORT, 1000);
  const f3 = await probe(EDGE_TTS_PORT, 1000);
  const f4 = await probePort(PC_PORT, 1000);
  const f5 = await probePort(VIDEO_PORT, 1000);
  console.log(`模型网关  ${OFM_PORT}: ${f0 ? '✅ 运行中' : '❌ 挂了'}`);
  console.log(`Bridge    ${BRIDGE_PORT}: ${f1 ? '✅ 运行中' : '❌ 挂了'}`);
  console.log(`ChatTTS   ${TTS_PORT}: ${f2 ? '✅ 运行中' : '❌ 挂了'}`);
  console.log(`Edge-TTS  ${EDGE_TTS_PORT}: ${f3 ? '✅ 运行中' : '❌ 挂了'}`);
  console.log(`电脑控制  ${PC_PORT}: ${f4 ? '✅ 运行中' : '❌ 挂了'}`);
  console.log(`视频/文件 ${VIDEO_PORT}: ${f5 ? '✅ 运行中' : '❌ 挂了'}`);
  console.log('\n现在可以关掉这个窗口（子进程会继续跑）');
  console.log('或者保持开着，它会自动保活');

  // 7. 保活
  setInterval(async () => {
    const a = await probe(BRIDGE_PORT, 500, BRIDGE_HEALTH);
    const b = await probe(TTS_PORT, 500);
    const c = await probe(EDGE_TTS_PORT, 500);
    const d = await probePort(OFM_PORT, 800);
    const e = await probePort(PC_PORT, 500);
    const v = await probePort(VIDEO_PORT, 500);
    if (!a) { console.log('[watchdog] bridge 挂了，重启'); spawnDetached(NODE, [BRIDGE], { cwd: QB, name: 'bridge' }); }
    if (!b) { console.log('[watchdog] tts 挂了，重启'); spawnDetached(TTS_PY, [TTS_SCRIPT, '--port', String(TTS_PORT), '--preload'], { cwd: TTS_DIR, name: 'tts' }); }
    if (!c) { console.log('[watchdog] edge-tts 挂了，重启'); spawnDetached(TTS_PY, [path.join(TTS_DIR, 'edge_tts_server.py'), '--port', String(EDGE_TTS_PORT)], { cwd: TTS_DIR, name: 'edge-tts' }); }
    if (!d) { console.log('[watchdog] 模型网关挂了，重启'); startOfm(); }
    if (!e) { console.log('[watchdog] 电脑控制服务挂了，重启'); spawnDetached(NODE, [PC_SCRIPT], { cwd: PC_DIR, name: 'pc', windowsHide: true }); }
    if (!v) { console.log('[watchdog] 视频/文件服务挂了，重启'); spawnDetached(NODE, [VIDEO_SCRIPT], { cwd: VIDEO_DIR, name: 'video', windowsHide: true }); }
  }, 30000);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
