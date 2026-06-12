---
name: run-playingaround
description: Run, screenshot, and visually verify the playingaround Hello World web app. Use when asked to run the app, take a screenshot, verify correctness, or confirm a change looks right.
---

# run-playingaround

A static HTML app (`index.html`). Served by Python's built-in HTTP server and
screenshotted with `npx playwright screenshot` (Chromium, headless). No build
step. `server.js` exists but is incomplete — use the Python server.

## Prerequisites

```bash
npx playwright install chromium   # one-time; already done in this container
```

Python 3 is always present. No other installs needed.

## Screenshot (agent path)

Run this from the repo root to start the server, capture a screenshot, and
stop the server:

```bash
# Start server
python3 -m http.server 8765 --directory /home/user/playingaround &
SERVER_PID=$!
sleep 1

# Screenshot
npx playwright screenshot --browser chromium \
  http://localhost:8765/ \
  /tmp/playingaround-screenshot.png

# Stop server
kill $SERVER_PID 2>/dev/null
echo "Screenshot saved to /tmp/playingaround-screenshot.png"
```

Then read the file at `/tmp/playingaround-screenshot.png` to verify it.

## Human path

```bash
cd /home/user/playingaround
python3 -m http.server 8765
# Open http://localhost:8765 in a browser, Ctrl-C to stop
```

## Gotchas

- **`server.js` does nothing.** It creates an Express app but has no routes
  and never calls `app.listen()`. There is also no `package.json` or
  `node_modules`. Use Python's HTTP server instead.
- **Port collision.** If port 8765 is in use from a previous run:
  `fuser -k 8765/tcp` before starting again. `pkill -f` can exit 144
  in this environment; `fuser -k` is more reliable.
- **Playwright Chromium not installed.** Run
  `npx playwright install chromium` once per container.
