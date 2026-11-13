# ShitChat

Self-destructing, end-to-end encrypted browser chat over [tailcat](https://github.com/tailscale/tailcat)
(Tailscale compiled to WebAssembly). Static site on GitHub Pages, no server. See README.md.

## Ground rules

- **The session must die when the host leaves.** That is the product, not a limitation. Never
  propose persistence, history, `localStorage`/IndexedDB, or host-less designs (WebRTC rooms, etc.).
  The only state allowed to outlive a reload is the tab's `sessionStorage` (30-min grace, `GRACE_MS`).
- Files live in memory only (blob: URLs, hub `files` map), never in `sessionStorage`: they are
  lost on a host reload, by design.
- Plain HTML/CSS/JS in `web/`, no build step, no dependencies, no service worker.
- The user writes in French (often voice-dictated): answer in French, read for intent.
  Code, comments, UI text and README stay in English.

## Layout

- `web/core.js`: protocol (Hub on the host, GuestSession on guests). No DOM, runs under Node.
  The wire-format comment at the top is the spec: keep it in sync, bump `PROTO` on changes.
- `web/app.js`: UI. `web/names.js`: random names.
- `build.sh`: fetches tailcat at a pinned commit, builds `main.wasm.gz`, copies `web/` into `dist/`.
- `.github/workflows/pages.yml`: build + deploy on every push to `main` (pushing = deploying).

## Testing

- After editing `web/`, `cp web/* dist/` is enough (no need to rebuild the wasm).
- `python3 -m http.server -d dist 8000` to serve.
- `node test/e2e.mjs dist`: protocol test over the real DERP relays (~2.5 min, needs network).
  Wrap it in `timeout 400`: it hangs ~1 run in 2 at the host-reload step, inside the tailcat wasm
  (pre-existing, test-only: same key re-listened in one Go process). Rerun if it does.
- UI: headless snap Chromium (`/snap/bin/chromium`) driven over CDP works. The snap can't read
  `/tmp`; put files for `DOM.setFileInputFiles` under `~/snap/chromium/common/`.
- Dev box is a Raspberry Pi without sudo; Go is in `~/.local/go`. Never `pkill -f` a pattern that
  matches your own command line (use `[h]ttp.server`).
