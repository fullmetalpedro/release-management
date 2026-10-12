// Screenshots for the README, taken from the running app with headless Microsoft Edge: the demo (AUTH_MODE=demo) on
// :5174 and the regular app, for the token sign-in screen, on :5173.
//
//   node docs/capture-screenshots.mjs docs/images [language]
//
// The interface follows the browser language; the default here is English (en).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2];
const LANG = process.argv[3] ?? 'en';
mkdirSync(OUT, { recursive: true });
const PORT = 9334;
const edge = spawn(
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--disable-gpu', `--lang=${LANG}`, `--accept-lang=${LANG}`, '--window-size=1440,900', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rm-shots-'))}`, 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json()).then((list) => list.find((t) => t.type === 'page')).catch(() => undefined);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) pending.get(message.id)?.(message);
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const run = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression: `(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim())); ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return result.result.value;
};
await send('Page.enable');
await send('Runtime.enable');
// The command-line flag alone doesn't always reach the first page, so the language is also set here.
const { result: version } = await send('Browser.getVersion');
await send('Network.enable');
await send('Network.setUserAgentOverride', { userAgent: version.userAgent.replace('Headless', ''), acceptLanguage: LANG });
await send('Emulation.setLocaleOverride', { locale: LANG });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const go = async (url, ms = 2800) => {
  await send('Page.navigate', { url });
  await sleep(ms);
};
const shot = async (name, clip) => {
  const { result } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  console.log('ok', name);
};

try {
  // ---- Demo ----
  const DEMO = 'http://localhost:5174';
  await go(`${DEMO}/auth/microsoft/login`);
  await run(`
    for (const key of Object.keys(localStorage)) if (key.startsWith('rm.')) localStorage.removeItem(key);
    localStorage.setItem('rm.repoColors', JSON.stringify({ 'p-getnota': { 'r-getnota-api': '#3B82F6', 'r-getnota-web': '#EC4899', 'r-getnota-worker': '#65A30D' } }));
  `);
  await go(`${DEMO}/`, 3500);
  await shot('board');

  await run(`button(/^(Repository|Repositório|Référentiel)/).click(); await wait(400); document.querySelectorAll('[role=dialog] button[aria-haspopup=dialog]')[1].click(); await wait(500);`);
  await shot('repository-colors', { x: 380, y: 100, width: 760, height: 300 });
  await run(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await wait(100);`);
  await go(`${DEMO}/`, 3000);

  await run(`document.querySelector('[aria-label$="PR #1295"]').click(); await wait(150); document.querySelector('[aria-label$="PR #1294"]').click(); await wait(400);`);
  await shot('create-release', { x: 760, y: 150, width: 680, height: 750 });

  await go(`${DEMO}/release?repo=r-getnota-api`, 3500);
  await shot('release');
  await run(`button(/^(Link task|Vincular task|Lier)/).click(); await wait(1800);`);
  await shot('link-task', { x: 20, y: 440, width: 900, height: 460 });

  // ---- Token sign-in ----
  await go('http://localhost:5173/login', 3000);
  await run(`
    document.querySelectorAll('[role=tablist] [role=tab]')[1]?.click(); await wait(600);
    const org = document.querySelector('#pat-organization');
    if (org) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(org, 'your-organization'); org.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(500); document.activeElement?.blur?.();
  `);
  await shot('token-sign-in');
} catch (error) {
  console.log('FAILED', String(error));
}
ws.close();
edge.kill();
process.exit(0);
