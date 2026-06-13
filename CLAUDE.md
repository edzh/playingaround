# playingaround — FTDC Replay

Express + WebSocket app that parses MongoDB FTDC diagnostic files and replays
them as an animated system diagram. Supports single-node replay and multi-host
sharded-cluster replay (upload one FTDC file per host; host identity is
auto-detected from type-0 metadata as `rsName/hostname:port`).

The owner develops from the Claude iPhone app — they cannot open localhost or
a browser. **Screenshots sent to their phone are the only way they can see
the app.**

## Mobile-first verification loop (required)

After ANY change that affects what the app serves or renders:

1. Run the relevant snap scene (boots its own server on :3001, screenshots
   iPhone + desktop into `/tmp/verify/`, exits non-zero on console errors):
   - `npm run verify` — static landing page (drop zone)
   - `npm run snap` — single-node demo, paused mid eviction-storm
   - `npm run snap -- cluster` — 5-host cluster demo, paused mid chunk
     migration; also captures `*-drill.png` of the hot shard's pipe diagram
2. Send `/tmp/verify/iphone.png` (and `desktop.png` when layout matters) to
   the user with the SendUserFile tool. Do this without being asked.
3. If a snap fails, fix the errors before declaring the change done.

## Commands

- `npm install` — once per fresh container (deps are gitignored)
- `npm start` — server on http://localhost:3000
- `npm test` — FTDC parser unit tests (synthetic real-format chunk)

## Architecture

- `lib/ftdc-parser.js` — raw-BSON FTDC decoder (varint deltas, zero-RLE,
  `keep` predicate, host identity from type-0 metadata)
- `lib/metric-extractor.js` — ~36 derived signals + subsystem health
- `lib/cluster-session.js` — time-aligns N host sessions onto a 1s grid
- `lib/cluster-demo.js` / `lib/demo-data.js` — synthetic incident generators
- `lib/ws-server.js` — replay protocol; `frame` (single) / `cluster-frame`
- `public/cluster-view.js` — host cards + shard balance bar + drill-down
- `routes/api.js` — `/api/upload`, `/api/cluster`, `/api/demo`,
  `/api/cluster-demo`

## Gotchas

- **playwright is pinned to exactly 1.56.1.** The sandbox network blocks
  `cdn.playwright.dev`, so newer playwright versions cannot download their
  browser builds. 1.56.1 matches the pre-cached Chromium in
  `/opt/pw-browsers`. Do not upgrade it.
- **No MongoDB binaries are obtainable in this sandbox** — fastdl.mongodb.org
  is blocked, apt has no server package, Docker daemon is down. Use the
  synthetic cluster demo; a real FTDC sample lives at
  `metrics.2026-05-14T09-16-28Z-00000`.
- If a port is stuck from a previous run: `fuser -k 3000/tcp` / `3001`
  (`pkill -f` exits 144 in this environment).
- FTDC metric key order is positional — never sort keys in the parser.
