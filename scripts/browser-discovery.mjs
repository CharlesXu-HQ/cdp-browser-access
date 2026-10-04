// 浏览器 CDP 端口发现 + 选择 - 单一职责模块
// 被 check-deps.mjs 和 cdp-proxy.mjs 共享。
//
// 选择规则（resolution）：
//   1. 调用方传入 override 参数（来自命令行 --browser） → 严格模式，找不到则硬错
//   2. config.env 里 WEB_ACCESS_BROWSER 设了 → 严格模式，找不到则硬错
//   3. 都没设 → "ask" 模式，提示调用方询问用户
//
// 不擅自降级：偏好不可用一律硬错，让用户介入。
// 持久态只有 config.env 一处；override 是单次 spawn 通过命令行参数表达，不读 process.env。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(SKILL_ROOT, 'config.env');

// 已知支持 chrome://inspect#remote-debugging toggle 的浏览器
// 加新浏览器：只改这里
export function knownBrowsers() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return [
        { id: 'chrome',        label: 'Chrome',         devToolsPath: path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort') },
        { id: 'chrome-canary', label: 'Chrome Canary',  devToolsPath: path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort') },
        { id: 'chromium',      label: 'Chromium',       devToolsPath: path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort') },
        { id: 'edge',          label: 'Microsoft Edge', devToolsPath: path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort') },
        // Arc 只在自带的 arc://inspect 开关模式下写 DevToolsActivePort，而那个服务器
        // 无条件拒绝外部 CDP 连接（实测 403 Connection rejected）；带 --remote-debugging-port
        // 启动时它反而不更新该文件（实测 mtime 停在开关模式那一刻）。所以 Arc 只能靠固定端口发现。
        { id: 'arc', label: 'Arc',
          devToolsPath: path.join(home, 'Library/Application Support/Arc/User Data/DevToolsActivePort'),
          flagPorts: [9333, 9229, 9222],
          launchHint: '先退出 Arc，再用 `open -a Arc --args --remote-debugging-port=9333` 启动。' +
                      '注意：Arc 自带的 arc://inspect#remote-debugging 开关虽然能开出端口，但它无条件拒绝外部 CDP 连接（403），不可用。' },
      ];
    case 'linux':
      return [
        { id: 'chrome',   label: 'Chrome',         devToolsPath: path.join(home, '.config/google-chrome/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium',       devToolsPath: path.join(home, '.config/chromium/DevToolsActivePort') },
        { id: 'edge',     label: 'Microsoft Edge', devToolsPath: path.join(home, '.config/microsoft-edge/DevToolsActivePort') },
      ];
    case 'win32':
      return [
        { id: 'chrome',   label: 'Chrome',         devToolsPath: path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium',       devToolsPath: path.join(localAppData, 'Chromium/User Data/DevToolsActivePort') },
        { id: 'edge',     label: 'Microsoft Edge', devToolsPath: path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort') },
        // Windows 上的 Arc 数据目录未实测；flagPorts 机制与 macOS 相同
        { id: 'arc', label: 'Arc',
          devToolsPath: path.join(localAppData, 'Arc/User Data/DevToolsActivePort'),
          flagPorts: [9333, 9229, 9222],
          launchHint: '先退出 Arc，再带 `--remote-debugging-port=9333` 参数启动；不要用 Arc 自带的 arc://inspect 开关（它会拒绝外部连接）。' },
      ];
    default:
      return [];
  }
}

// TCP 端口监听检测
// 用 TCP connect 而非 WebSocket，避免触发浏览器的远程调试授权弹窗。
export function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

// 读 config.env 文件（不写入 process.env，分清来源）
// 格式：KEY=VALUE，# 开头是注释
function readConfig() {
  const cfg = {};
  let content;
  try { content = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch { return cfg; }
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && v) cfg[k] = v;
  }
  return cfg;
}

// --- CDP 端点可用性校验 -------------------------------------------------
// 仅凭「端口活着」不足以判定可用：Arc 自带的 arc://inspect 开关会开出端口并写
// DevToolsActivePort，但其服务器无条件拒绝外部 CDP 连接（HTTP 403）。因此这里对每个
// 候选端点做一次真实 WebSocket 握手，只认能握上的。

function wsUrlFor(port, wsPath) {
  return wsPath ? `ws://127.0.0.1:${port}${wsPath}` : `ws://127.0.0.1:${port}/devtools/browser`;
}

// 向 /json/version 询问带 UUID 的完整 wsPath；端点不可用（404 等）时返回 null
async function fetchWsPath(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const info = await res.json();
    if (!info || !info.webSocketDebuggerUrl) return null;
    return new URL(info.webSocketDebuggerUrl).pathname || null;
  } catch {
    return null;
  }
}

// 一次真实握手（连上即断开）。不发送 Origin —— 带 Origin 会被 Chrome/Arc 以 403 拒绝。
function probeHandshake(port, wsPath, timeoutMs = 2500) {
  if (typeof globalThis.WebSocket === 'undefined') {
    return Promise.resolve({ ok: false, err: '当前 Node 无原生 WebSocket（需 22+）' });
  }
  return new Promise((resolve) => {
    let sock = null;
    let settled = false;
    let timer = null;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (sock) sock.close(); } catch {}
      resolve({ ok, err });
    };
    timer = setTimeout(() => done(false, '握手超时'), timeoutMs);
    try {
      sock = new globalThis.WebSocket(wsUrlFor(port, wsPath));
    } catch (e) {
      return done(false, (e && e.message) || String(e));
    }
    const onOpen = () => done(true);
    const onErr = (e) => done(false, (e && (e.message || (e.error && e.error.message))) || '握手失败');
    if (typeof sock.addEventListener === 'function') {
      sock.addEventListener('open', onOpen);
      sock.addEventListener('error', onErr);
    }
    if ('onopen' in sock) sock.onopen = onOpen;
    if ('onerror' in sock) sock.onerror = onErr;
    if (typeof sock.on === 'function') {
      sock.on('open', onOpen);
      sock.on('error', onErr);
    }
  });
}

// 在一个端口上找出真正可用的 wsPath。
// 候选顺序：DevToolsActivePort 记录的路径 → /json/version 提供的完整路径 → 短路径。
// 不同 Chromium 变体接受的形式不同：Chrome 认短路径，Arc 与 headless Chrome 只认完整路径。
async function resolveEndpoint(port, wsPathHint = null) {
  const candidates = [];
  if (wsPathHint) candidates.push({ wsPath: wsPathHint, label: '记录路径' });
  const httpPath = await fetchWsPath(port);
  if (httpPath && httpPath !== '/devtools/browser' && httpPath !== wsPathHint) {
    candidates.push({ wsPath: httpPath, label: '/json/version' });
  }
  if (!candidates.some((c) => !c.wsPath)) candidates.push({ wsPath: null, label: '短路径' });

  let lastErr = null;
  for (const c of candidates) {
    const r = await probeHandshake(port, c.wsPath);
    if (r.ok) return { ok: true, wsPath: c.wsPath, via: c.label };
    lastErr = r.err;
  }
  return { ok: false, err: lastErr };
}

// 返回真正可用的浏览器列表。两轮进行：
//   第一轮 —— 按各浏览器的 DevToolsActivePort 认领端口；
//   第二轮 —— 带 flagPorts 的浏览器（如 Arc，它不更新该文件）认领剩余端口。
// 先认领再兜底，避免把 Chrome 占着的 9222 误记到 Arc 头上。
async function detectAll() {
  const result = [];
  const claimed = new Set();
  const all = knownBrowsers();

  for (const browser of all) {
    let content;
    try { content = fs.readFileSync(browser.devToolsPath, 'utf8'); }
    catch { continue; }
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!(port > 0 && port < 65536)) continue;
    if (claimed.has(port)) continue;
    if (!(await checkPort(port))) continue;
    const ep = await resolveEndpoint(port, lines[1] || null);
    if (!ep.ok) continue; // 端口活着但拒绝外部连接 —— 例如 Arc 的开关模式
    claimed.add(port);
    result.push({ ...browser, port, wsPath: ep.wsPath, via: `DevToolsActivePort/${ep.via}` });
  }

  for (const browser of all) {
    if (!browser.flagPorts || !browser.flagPorts.length) continue;
    if (result.some((b) => b.id === browser.id)) continue;
    for (const port of browser.flagPorts) {
      if (claimed.has(port)) continue;
      if (!(await checkPort(port))) continue;
      const ep = await resolveEndpoint(port, null);
      if (!ep.ok) continue;
      claimed.add(port);
      result.push({ ...browser, port, wsPath: ep.wsPath, via: `flagPorts/${ep.via}` });
      break;
    }
  }
  return result;
}

// 决策入口
// 参数：override — 调用方解析自命令行 --browser 的值（null 表示未传）
// 返回 { kind, browser?, source?, detected, configured, override? }
//   kind ∈ 'ok' | 'ambiguous' | 'mismatch' | 'empty'
//   source ∈ 'override' | 'preference' | undefined
//   ambiguous = 没设偏好 + 至少一个浏览器开了 toggle，需问用户
//   mismatch  = override/配偏好设了但未检测到对应 toggle，硬错
//   empty     = 0 浏览器开 toggle 且未设偏好/override
export async function selectBrowser(override = null) {
  const detected = await detectAll();
  const configured = readConfig().WEB_ACCESS_BROWSER || null;

  // 1. 命令行 override（最高优先，单次有效）
  if (override) {
    const match = detected.find(b => b.id === override);
    if (match) return { kind: 'ok', browser: match, source: 'override', detected, configured, override };
    return { kind: 'mismatch', source: 'override', detected, configured, override };
  }

  // 2. config.env preference（持久）
  if (configured) {
    const match = detected.find(b => b.id === configured);
    if (match) return { kind: 'ok', browser: match, source: 'preference', detected, configured };
    return { kind: 'mismatch', source: 'preference', detected, configured };
  }

  // 3. 无偏好 —— 一律询问用户（哪怕 detected 只有一个）
  if (detected.length === 0) {
    return { kind: 'empty', detected, configured };
  }
  return { kind: 'ambiguous', detected, configured };
}

// 兜底：扫描常用固定端口
// 适用场景：用户手动 --remote-debugging-port=9222 启动浏览器，
// 此时 DevToolsActivePort 可能不在默认 user-data-dir。
export async function findFallbackPort() {
  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) return port;
  }
  return null;
}
