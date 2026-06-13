/**
 * Starts the server, loads a demo session, plays for a few seconds, then
 * captures iPhone + desktop screenshots at an interesting moment.
 *
 * Scenes:
 *   node scripts/demo-screenshot.mjs            → single-node eviction storm
 *   node scripts/demo-screenshot.mjs cluster    → 5-host cluster mid-migration
 *                                                 (+ drill-down on the hot shard)
 */
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const SCENE  = process.argv[2] === 'cluster' ? 'cluster' : 'single';
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
  await page.click(SCENE === 'cluster' ? '#cluster-demo-btn' : '#demo-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });

  // Fast-forward at 60× into the interesting region:
  //   single  → eviction storm starts at frame ~200
  //   cluster → chunk migration window is frames 240–420; aim for ~300
  await page.evaluate(() => {
    document.getElementById('speed-select').value = '60';
    document.getElementById('btn-play').click();
  });
  await page.waitForTimeout(SCENE === 'cluster' ? 5000 : 4000);

  // Pause so the screenshot is stable
  await page.click('#btn-play');
  await page.waitForTimeout(400);

  const file = `${OUTDIR}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[${name}] ${file}`);

  // Cluster bonus shot: drill into the hot shard's full pipe diagram
  if (SCENE === 'cluster') {
    await page.click('.host-card:nth-child(2)'); // shard0 (hot)
    await page.waitForSelector('.drill-overlay', { state: 'visible' });
    await page.waitForTimeout(300);
    const drillFile = `${OUTDIR}/${name}-drill.png`;
    await page.screenshot({ path: drillFile, fullPage: false });
    console.log(`[${name}-drill] ${drillFile}`);
  }

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
console.log(`\nDEMO SCREENSHOT OK (${SCENE})`);
