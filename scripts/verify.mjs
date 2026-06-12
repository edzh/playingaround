// Mobile-first visual verification pipeline.
// Boots server.js, screenshots iPhone + desktop viewports, fails on
// console/page errors. Screenshots land in /tmp/verify/.
//
// Usage: node scripts/verify.mjs [path]   (path defaults to /)

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const OUT = '/tmp/verify';
const pagePath = process.argv[2] || '/';

mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['server.js'], { stdio: 'pipe' });
let serverOutput = '';
server.stdout.on('data', (d) => (serverOutput += d));
server.stderr.on('data', (d) => (serverOutput += d));

async function waitForServer() {
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(BASE);
			if (res.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error(`Server never came up on ${BASE}\n${serverOutput}`);
}

const targets = [
	{ name: 'iphone', options: devices['iPhone 14'] },
	{ name: 'desktop', options: { viewport: { width: 1280, height: 800 } } },
];

let failed = false;

try {
	await waitForServer();
	const browser = await chromium.launch();

	for (const { name, options } of targets) {
		const context = await browser.newContext(options);
		const page = await context.newPage();

		const errors = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
		});
		page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
		page.on('requestfailed', (req) =>
			errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText})`)
		);

		const url = BASE + pagePath;
		const response = await page.goto(url, { waitUntil: 'networkidle' });
		if (!response.ok()) errors.push(`HTTP ${response.status()} on ${url}`);

		const file = `${OUT}/${name}.png`;
		await page.screenshot({ path: file, fullPage: true });
		console.log(`[${name}] ${file}`);

		if (errors.length) {
			failed = true;
			for (const e of errors) console.error(`[${name}] ERROR ${e}`);
		}
		await context.close();
	}

	await browser.close();
} finally {
	server.kill();
}

if (failed) {
	console.error('\nVERIFY FAILED — errors above. Screenshots still written.');
	process.exit(1);
}
console.log('\nVERIFY OK');
