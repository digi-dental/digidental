/**
 * Voice-demo call path tests.
 *
 * The site is a single static HTML file with no build step, so these tests load index.html in a
 * real browser, stub `navigator.mediaDevices.getUserMedia` and the Vapi SDK constructor, and then
 * drive the actual component. Nothing is re-implemented here: the code under test is the code
 * that ships.
 *
 * Run: node test/vapi-call.test.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const NM = process.env.DD_TEST_MODULES || path.join(ROOT, 'node_modules');
const CHROME = process.env.DD_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8231;

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, approved: true }));
  }
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f);
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript'
    : ext === '.png' ? 'image/png' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

/**
 * Boots the page with the SDK and microphone replaced by controllable fakes.
 * @param {{mic?:string, assistantId?:string|null, sdk?:boolean}} opts
 */
async function boot(opts = {}) {
  // reducedMotion stops the mascot's bob animation, which otherwise never settles and
  // makes Playwright's stability check time out on click.
  const ctx = await browser.newContext({ permissions: [], reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  // Short default: a missing element is a test result, not something to wait 30 seconds for.
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  // React from local node_modules — the CDN is not reachable in CI.
  await page.route('**/unpkg.com/**', route => {
    const url = route.request().url();
    const file = url.includes('react-dom')
      ? path.join(NM, 'react-dom/umd/react-dom.production.min.js')
      : path.join(NM, 'react/umd/react.production.min.js');
    return fs.existsSync(file)
      ? route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file, 'utf8') })
      : route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  // Never fetch the real Vapi SDK; the fake is installed before any script runs.
  await page.route('**/@vapi-ai/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default window.__FakeVapi;' }));

  await page.addInitScript(({ mic, sdk }) => {
    window.__calls = [];       // every start() argument, in order
    window.__instances = 0;    // how many clients were constructed
    window.__stops = 0;
    window.__listeners = {};

    class FakeVapi {
      constructor(key) {
        window.__instances++;
        this.key = key; this._h = {};
        window.__vapi = this;
      }
      on(ev, fn) {
        (this._h[ev] = this._h[ev] || []).push(fn);
        window.__listeners[ev] = (window.__listeners[ev] || 0) + 1;
        return this;
      }
      removeAllListeners() { this._h = {}; return this; }
      emit(ev, arg) { (this._h[ev] || []).forEach(f => f(arg)); }
      start(assistant) {
        window.__calls.push(assistant);
        // Resolve like the real SDK, then announce the call on the next tick.
        return Promise.resolve({ id: 'call_' + window.__calls.length }).then(c => {
          setTimeout(() => this.emit('call-start'), 10);
          return c;
        });
      }
      stop() { window.__stops++; setTimeout(() => this.emit('call-end'), 5); return Promise.resolve(); }
      getLocalAudioLevel() { return 0.5; }
    }
    window.__FakeVapi = FakeVapi;
    if (sdk !== false) { window.DentyVapiCtor = FakeVapi; }

    // Controllable microphone.
    const makeTrack = (over = {}) => Object.assign({
      kind: 'audio', label: 'Fake Mic', readyState: 'live', enabled: true, muted: false, stop() {}
    }, over);
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = () => {
      const fail = name => { const e = new Error(name); e.name = name; return Promise.reject(e); };
      if (mic === 'denied') return fail('NotAllowedError');
      if (mic === 'missing') return fail('NotFoundError');
      if (mic === 'busy') return fail('NotReadableError');
      let track = makeTrack();
      if (mic === 'inactive') track = makeTrack({ readyState: 'ended' });
      window.__track = track;
      return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
    };
  }, { mic: opts.mic || 'ok', sdk: opts.sdk });

  const url = `http://127.0.0.1:${PORT}/` + (opts.assistantId === null ? '?__noassistant=1' : '');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait for the component to mount rather than for the network to go quiet: third-party
  // requests are aborted here, so 'networkidle' never arrives.
  await page.waitForFunction(() => !!window.__ddRoot, null, { timeout: 15000 });
  await page.waitForTimeout(250);

  // Blank the assistant id after boot when the test needs a missing-config case.
  if (opts.assistantId === null) {
    await page.evaluate(() => {
      const root = window.__ddRoot;
      if (root) root.VAPI_ASSISTANT_ID = '';
    });
  }
  return { page, ctx, errors };
}

// The mascot animates continuously, so the click is forced rather than waiting for stability.
// `.first()` because the sticky mobile bar renders a second control with the same label.
const clickToothy = page =>
  page.locator('button[aria-label^="Talk to the AI receptionist"]').first().click({ force: true });
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 1. The configured assistant id is passed to start().
{
  const { page, ctx } = await boot();
  await clickToothy(page);
  await page.waitForTimeout(700);
  const calls = await page.evaluate(() => window.__calls);
  const expected = await page.evaluate(() => window.__ddRoot && window.__ddRoot.VAPI_ASSISTANT_ID);
  check('configured assistant id is passed to start()',
    calls.length === 1 && calls[0] === expected && !!expected, `start(${JSON.stringify(calls[0])})`);
  await ctx.close();
}

// 2. A missing assistant id must not create a call.
{
  const { page, ctx } = await boot({ assistantId: null });
  await clickToothy(page);
  await page.waitForTimeout(700);
  const calls = await page.evaluate(() => window.__calls);
  check('missing assistant id prevents call creation', calls.length === 0, `${calls.length} call(s)`);
  await ctx.close();
}

// 3. Microphone denial is handled and never starts a call.
{
  const { page, ctx } = await boot({ mic: 'denied' });
  await clickToothy(page);
  await page.waitForTimeout(700);
  const calls = await page.evaluate(() => window.__calls);
  const alert = await page.locator('[role="alert"]').count();
  check('denied microphone is handled, no call created', calls.length === 0 && alert > 0,
    `${calls.length} call(s), ${alert} alert(s)`);
  await ctx.close();
}

// 3b. NotFoundError / NotReadableError are handled the same way.
for (const [mode, label] of [['missing', 'NotFoundError'], ['busy', 'NotReadableError'], ['inactive', 'inactive track']]) {
  const { page, ctx } = await boot({ mic: mode });
  await clickToothy(page);
  await page.waitForTimeout(700);
  const calls = await page.evaluate(() => window.__calls);
  check(`${label} is handled, no call created`, calls.length === 0, `${calls.length} call(s)`);
  await ctx.close();
}

// 4. Duplicate Start clicks create exactly one call.
{
  const { page, ctx } = await boot();
  await clickToothy(page);
  await clickToothy(page).catch(() => {});   // disabled by now; the failure is the point
  await page.evaluate(() => window.__ddRoot && window.__ddRoot.startDemo());
  await page.evaluate(() => window.__ddRoot && window.__ddRoot.startDemo());
  await page.waitForTimeout(800);
  const calls = await page.evaluate(() => window.__calls);
  check('duplicate Start clicks create one call', calls.length === 1, `${calls.length} call(s)`);
  await ctx.close();
}

// 5. One client instance, and retrying does not duplicate listeners.
{
  const { page, ctx } = await boot({ mic: 'denied' });
  await clickToothy(page);
  await page.waitForTimeout(500);
  await page.locator('text=Try again').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  const { instances, listeners } = await page.evaluate(() => ({
    instances: window.__instances, listeners: window.__listeners
  }));
  check('one client instance across retries', instances === 1, `${instances} instance(s)`);
  check('listeners are not duplicated on retry', (listeners['call-start'] || 0) === 1,
    `call-start listeners: ${listeners['call-start']}`);
  await ctx.close();
}

// 6. Cleanup happens after the call ends, not during setup.
{
  const { page, ctx } = await boot();
  await clickToothy(page);
  await page.waitForTimeout(600);
  const during = await page.evaluate(() => ({ live: window.__ddRoot.state.toothy, stops: window.__stops }));
  await page.evaluate(() => window.__ddRoot.hangUp());
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ stops: window.__stops, stream: !!window.__ddRoot._micStream }));
  check('no stop() during connection/setup', during.stops === 0, `stops during setup: ${during.stops}`);
  check('call reached live state', during.live === 'live', `state: ${during.live}`);
  check('microphone released after call end', after.stops === 1 && after.stream === false,
    `stops: ${after.stops}, stream retained: ${after.stream}`);
  await ctx.close();
}

// 7. With no SDK at all the page must not throw.
{
  const { page, ctx, errors } = await boot({ sdk: false });
  await clickToothy(page);
  await page.waitForTimeout(900);
  check('missing SDK does not throw', errors.length === 0, errors[0] || 'no page errors');
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
