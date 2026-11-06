/**
 * 出站文本补丁（幂等）
 *
 * 用法：node outbound-transform.patch.js <profileDir>
 *
 * 1) 给 @tencent-connect/dsh-qqbot 的 outbound.js 注入“技术错误不外泄”过滤：
 *    agent 调模型失败时，原始 QUOTA / AUTH / 429 之类的技术错误会直接发到 QQ，
 *    这里改成一句人话，原始错误仍然写进 bot.log 方便排查。
 * 2) 注册 globalThis.__dshOutboundTextTransform 钩子的入口（如果宿主支持）。
 */
const fs = require('fs');
const path = require('path');

const MARK = '/* __DAFY_TURN_END_FILTER__ */';
const MSG = '⚠️ 鱼儿刚刚脑子卡了一下，稍后再跟我说一次吧～';

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) walk(p, out);
      else walk(p, out);
    } else if (e.name === 'outbound.js' && p.includes(path.join('dsh-qqbot', 'lib', 'transport'))) {
      out.push(p);
    }
  }
  return out;
}

function patchFile(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return 'read-fail'; }
  if (src.includes(MARK)) return 'already';

  const needle = 'await this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');';
  if (!src.includes(needle)) return 'pattern-missing';

  const replacement = [
    MARK,
    'const __raw = `本轮异常结束 ${failure.code}: ${failure.message}`;',
    '                this.logger.error(`im-qqbot: ${__raw}`);',
    "                const __tech = /QUOTA|AUTH|RATE|LIMIT|API|error|exceed|http|40[0-9]|50[0-9]/i.test(failure.code + ' ' + failure.message) || String(failure.message || '').length > 120;",
    "                await this.send(record, __tech ? '" + MSG + "' : __raw, 'sendTurnEndError');"
  ].join('\n                ');

  const next = src.replace(needle, replacement);
  if (next === src) return 'no-change';
  try {
    fs.writeFileSync(file, next, 'utf8');
    return 'patched';
  } catch (e) {
    return 'write-fail: ' + e.message;
  }
}

const root = process.argv[2];
if (!root) {
  console.error('usage: node outbound-transform.patch.js <profileDir>');
  process.exit(2);
}
if (!fs.existsSync(root)) {
  console.log('profile not found: ' + root);
  process.exit(0);
}

const files = walk(root);
if (!files.length) {
  console.log('no dsh-qqbot outbound.js found');
  process.exit(0);
}
const results = files.map((f) => path.basename(path.dirname(path.dirname(path.dirname(f)))) + ':' + patchFile(f));
console.log('outbound-transform -> ' + results.join(', '));
