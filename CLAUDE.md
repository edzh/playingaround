# playingaround

Express app serving static HTML (`index.html`). The owner develops from the
Claude iPhone app — they cannot open localhost or a browser. **Screenshots
sent to their phone are the only way they can see the app.**

## Mobile-first verification loop (required)

After ANY change that affects what the app serves or renders:

1. Run `npm run verify` — boots the server, screenshots iPhone + desktop
   viewports into `/tmp/verify/`, and exits non-zero on console/page errors.
2. Send `/tmp/verify/iphone.png` (and `desktop.png` when layout matters) to
   the user with the SendUserFile tool. Do this without being asked.
3. If verify fails, fix the errors before declaring the change done.

To verify a page other than `/`: `node scripts/verify.mjs /path.html`

## Commands

- `npm install` — once per fresh container (deps are gitignored)
- `npm start` — server on http://localhost:3000
- `npm run verify` — the verification pipeline (use this, not manual curl)

## Gotchas

- **playwright is pinned to exactly 1.56.1.** The sandbox network blocks
  `cdn.playwright.dev`, so newer playwright versions cannot download their
  browser builds. 1.56.1 matches the pre-cached Chromium in
  `/opt/pw-browsers`. Do not upgrade it.
- If port 3000 is stuck from a previous run: `fuser -k 3000/tcp`
  (`pkill -f` exits 144 in this environment).
