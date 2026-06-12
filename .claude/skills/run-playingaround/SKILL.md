---
name: run-playingaround
description: Run, screenshot, and visually verify the playingaround web app on iPhone and desktop viewports. Use when asked to run the app, take a screenshot, verify correctness, or confirm a change looks right on mobile.
---

# run-playingaround

Express app serving static HTML. The owner works from the Claude iPhone app,
so verification means running `scripts/verify.mjs` and **sending the
screenshots to the user via SendUserFile** — that's the only way they see
the app. Paths below are relative to the repo root.

## Setup (fresh container)

```bash
npm install
```

Chromium for playwright 1.56.1 is pre-cached in `/opt/pw-browsers` — no
`playwright install` needed. Do NOT upgrade playwright (see Gotchas).

## Verify (agent path — use this)

```bash
npm run verify
```

- Boots `server.js` on port 3000, screenshots `/` at iPhone 14 and
  1280×800 desktop viewports, kills the server.
- Output: `/tmp/verify/iphone.png` and `/tmp/verify/desktop.png`
- Exits 1 if any console error, page error, failed request, or non-2xx
  response occurred. Screenshots are still written on failure.
- Other pages: `node scripts/verify.mjs /otherpage.html`

After running, **send `/tmp/verify/iphone.png` to the user** (SendUserFile),
plus `desktop.png` when layout is in question.

## Run (human path)

```bash
npm start   # http://localhost:3000, Ctrl-C to stop
```

Useless headless — there is no browser to open. Use the verify path.

## Gotchas

- **playwright must stay pinned at 1.56.1.** The sandbox network egress
  blocks `cdn.playwright.dev`, so any newer playwright cannot download its
  browser build (403 "Host not in allowlist"). 1.56.1 matches the
  pre-cached `/opt/pw-browsers/chromium-1194`.
- **Port 3000 stuck:** `fuser -k 3000/tcp`. `pkill -f` exits 144 in this
  environment and kills your own shell pipeline.
- verify.mjs uses `waitUntil: 'networkidle'` — fine for this static app;
  if websockets are ever added, switch to waiting for a selector.
