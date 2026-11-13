# ShitChat

A private, end-to-end encrypted, **serverless** chat that **self-destructs** when
the host leaves. Just a static page on GitHub Pages.

👉 **https://lucaslenglet.github.io/ShitChat/**

1. Click **Create a session**: your tab becomes the host and gives you a link.
   You can set a **password** first (optional), and tweak the session under
   **Advanced options** (see below).
2. Send the link to whoever you want. Opening it joins the session under a random
   name ("Philosophical Capybara", "Cranky Narwhal"…), after typing the password
   if there is one.
3. Chat away: participant count, "X is typing…", sent / delivered / seen.
   Send **photos and files** with 📎 (or 📷 on a phone, or paste / drop them).
   Received ones arrive as a name and a size: **Load** shows a photo in the chat
   (tap it to view it full screen), **Download** saves a file. Then each one has a
   **Save** button (and **Share** on Android, e.g. to put a photo in your
   gallery). Up to 50 MB per file.
4. When the host closes their tab (or clicks **Destroy**), everyone is disconnected,
   the messages vanish and **the link will never work again**.

Reloading the page doesn't kill anything: host or guest, you pick the session back
up where you were (same name, same messages). Only closing the tab does.

**Install it as an app** (Android/Chrome: ⋮ menu → *Install app*; iOS/Safari: Share →
*Add to Home Screen*). It's just a web app manifest: there's no service worker, so
nothing is cached or stored on the device. On Android, invite links then open
directly in the app.

### Advanced options

Folded under the password field when creating a session. The defaults are an
open room where everyone can do everything. The host's tab enforces them; "who
can write / send files" never restricts the host itself.

- **Max people** (host included): newcomers past it are turned away. Someone who
  loses the connection keeps their seat for 30 minutes; someone who leaves frees it.
- **Who can write**: everyone, or only the host (announcement mode).
- **Who can send files**: everyone, or only the host.
- **Received files**: *on demand* (each participant chooses what to fetch), or
  *automatic* (everything is fetched as soon as it's posted).
- **Max file size**: anything from 1 to 50 MB.
- **Newcomers see**: *everything* sent since the session started, or *only new
  ones* (what's posted after they joined, files included).
- **Read receipts** and **"Is typing…"**: on or off, for everyone.

And during the session, the host can:

- **Lock** the session (in the Invite panel): the link lets nobody new in, until
  unlocked. Someone who lost the connection can still take their seat back.
- **Remove** someone (✕ next to their name). Their tab can't take its seat back;
  opening the link again counts as a new arrival, so lock first if needed.

## How it works

ShitChat is built on [tailcat](https://github.com/tailscale/tailcat), Tailscale's
"netcat": a WireGuard tunnel between two machines, with no account and no control
server. tailcat is compiled to WebAssembly and runs right in the browser.

```
 Host tab                                      Guest tabs
┌──────────────────────┐                     ┌──────────────────────┐
│ tailcat Server (wasm) │◄── WireGuard ──────►│ tailcat Client (wasm) │
│ Hub: relays           │    via DERP relays  └──────────────────────┘
│ everything, keeps     │◄── WireGuard ──────►┌──────────────────────┐
│ messages in memory    │                     │ tailcat Client (wasm) │
└──────────────────────┘                     └──────────────────────┘
```

- **The link is the key.** It carries the host's tailcat address (`#tc…`): their
  WireGuard public key, a random pre-shared key (PSK) and which relay to use. It
  lives after the `#`, which browsers never send to GitHub, and the page wipes it
  from the address bar as soon as it has read it.
- **Self-destruct.** The host's key only lives in their tab: in memory, and in the
  tab's `sessionStorage` so that a reload can pick it back up. `sessionStorage`
  belongs to that one tab and is wiped when it closes. Tab closed ⇒ key gone ⇒
  nobody can ever connect to that address again, even with the link.
- **Interruptions.** If the host's page goes away without ending the session
  (reload, phone asleep, flaky network), guests keep trying to reconnect for
  **30 minutes**, then give up for good. A reloaded host listens again with the same
  key; a reloaded guest gets their seat back with a secret token from the host.
  Saved state older than 30 minutes is thrown away, and so is a host page that was
  frozen longer than that: the session is over.
- **Star topology.** Each guest has a single tunnel, to the host, which relays the
  messages. Late joiners get the messages exchanged since the session started
  (kept by the host's tab, nowhere else).
- **Password (optional).** Without one, the link is enough to get in. With one,
  the host only lets in guests who send it. It travels inside the WireGuard tunnel,
  and the host's tab only keeps a salted PBKDF2 hash of it. A guest taking their
  seat back after a reload doesn't need it again (their secret token is enough).
  Wrong guesses are slowed down: one per second at most for the whole session, and
  three per connection.
- **Files.** The sender streams the file to the host, which keeps it **in memory
  only** (up to 150 MB for all files together, the oldest go first) and posts a
  message about it. Each participant's tab fetches it from the host when they ask
  for it (or right away, if the host chose so) and keeps it in memory too, as a
  `blob:` URL. Nothing is written to disk unless you
  press Save. File transfers go at a lower priority than messages, so the chat
  keeps flowing during a transfer. Through the relays, expect a few hundred KB/s
  (~700 KB/s measured): a phone photo takes a few seconds, a 50 MB video about two
  minutes, and the host relays it to each participant in turn.
- **Protocol.** Newline-delimited JSON over the TCP tunnel (see
  [`web/core.js`](web/core.js)); file contents travel as raw bytes after their
  JSON line. Heartbeats every 5 s: a participant silent for
  20 s is considered gone.

## What it protects, and what it doesn't

- ✅ Messages are end-to-end encrypted by WireGuard (+ PSK). Neither GitHub nor the
  relays can read them or join the session.
- ✅ No account, no database, no `localStorage`. The only thing kept is the tab's
  own `sessionStorage` (host: key + messages; guest: address + seat), which dies
  with the tab.
- ⚠️ While the session runs, the host's `sessionStorage` holds the key and the
  messages in the clear, and the browser may write it to disk (to restore tabs).
  Browsers' "reopen closed tab" brings `sessionStorage` back: done within
  30 minutes, it revives the session. "Duplicate tab" copies it too, which ShitChat
  detects and refuses.
- ⚠️ **Anyone who gets the link can join** while the session exists, unless you
  set a password. Send the link over a channel you trust, and the password over
  another one. Guessing is slowed down but not impossible: pick a real password,
  not "1234".
- ⚠️ In a browser, tailcat can't make direct connections: **all (encrypted)
  traffic goes through Tailscale's DERP relays**, which can therefore see who talks
  to whom (IP addresses, ephemeral public keys, traffic volume). These relays are
  free, rate-limited, and may be cut off at any time.
- ⚠️ The host relays messages: they pass through the host's tab in the clear (just
  like for any participant).
- ⚠️ tailcat is experimental with no API stability promises; the version used is
  pinned in [`build.sh`](build.sh).
- ⚠️ Files are not kept across a **host reload**: the backlog survives (it's in
  `sessionStorage`), the files don't (too big for it). Participants who already
  received a file keep it; the others see "no longer available".
- ⚠️ Received files are only displayed if they're images or videos in common
  formats (JPEG, PNG, GIF, WebP, AVIF, MP4, WebM…); everything else can only be
  saved, never opened inside the page.
- On mobile, if the host switches to another app, the browser may suspend the tab.
  Guests wait for up to 30 minutes; past that, the session is over.

## Development

Requirements: Go ≥ 1.27 and git.

```sh
./build.sh                    # compile tailcat to wasm + copy web/ → dist/
python3 -m http.server -d dist 8000
node test/e2e.mjs dist        # end-to-end test (host + guests in Node, real relays, ~2 min)
```

- `web/`: the page (plain HTML/CSS/JS, no build step). `core.js` = protocol, no DOM.
- `build.sh`: fetches tailcat at a pinned commit, compiles tailcat's `web/main_js.go`
  to WebAssembly (~27 MB, 6.5 MB gzipped), then adds the page.
- `.github/workflows/pages.yml`: build + deploy to GitHub Pages on every push to
  `main`. The end-to-end test isn't run there; run it by hand when touching the
  protocol.

## Credits

The networking engine is Tailscale's [tailcat](https://github.com/tailscale/tailcat)
(BSD-3-Clause license, copied into the published site as `LICENSE-tailcat.txt`).
Loading the gzipped wasm follows the approach of tailcat's web demo.
