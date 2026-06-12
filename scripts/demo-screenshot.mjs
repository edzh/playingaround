/**
 * Starts the server, loads the demo session, plays for a few seconds,
 * then captures iPhone + desktop screenshots at the "eviction storm" moment.
 */
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT   = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTDIR = '/tmp/verify';

await mkdir(OUTDIR, { recursive: true });

// ── Start server ──────────────────────────────────────────────────────────
const srv = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '3001' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ready = false;
srv.stdout.on('data', d => { if (d.toString().includes('listening')) ready = true; });
srv.stderr.on('data', d => process.stderr.write(d));

await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error('server did not start')), 12000);
  const poll = setInterval(() => { if (ready) { clearTimeout(deadline); clearInterval(poll); resolve(); } }, 100);
});

// ── Launch browser ────────────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const errors = [];
async function shot(name, viewport) {
  const ctx  = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console',   m => {
    if (m.type() === 'error') {
      const t = m.text();
      // Ignore benign missing-resource noise (favicon, etc.)
      if (t.includes('favicon') || t === 'Failed to load resource: the server responded with a status of 404 (Not Found)') return;
      errors.push(t);
    }
  });

  await page.goto('http://localhost:3001', { waitUntil: 'networkidle' });

  // Click "Try Demo"
  await page.click('#demo-btn');

  // Wait for app view to appear (dropzone hides, app shows)
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });

  // Auto-play at 60× to fast-forward into the eviction storm region
  // (frame ~200 of 600 = phase ~0.33 where appEvict kicks in)
  await page.evaluate(() => {
    document.getElementById('speed-select').value = '60';
    document.getElementById('btn-play').click();
  });

  // Let it play for 4 seconds (= 240 simulated seconds at 60×, ~frame 240)
  await page.waitForTimeout(4000);

  // Pause so screenshot is stable
  await page.click('#btn-play');
  await page.waitForTimeout(300);

  const file = `${OUTDIR}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[${name}] ${file}`);
  await ctx.close();
}

await shot('iphone',  { width: 390,  height: 844  });
await shot('desktop', { width: 1280, height: 800  });

await browser.close();
srv.kill();

if (errors.length) {
  console.error('Console errors:', errors);
  process.exit(1);
}
console.log('\nDEMO SCREENSHOT OK');
