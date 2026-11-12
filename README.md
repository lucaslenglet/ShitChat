# ShitChat

A private, end-to-end encrypted, **serverless** chat that **self-destructs** when
the host leaves. Just a static page on GitHub Pages.

👉 **https://lucaslenglet.github.io/ShitChat/**

1. Click **Create a session**: your tab becomes the host and gives you a link.
2. Send the link to whoever you want. Opening it joins the session under a random
   name ("Philosophical Capybara", "Cranky Narwhal"…).
3. Chat away: participant count, "X is typing…", sent / delivered / seen.
4. When the host closes their tab (or clicks **Destroy**), everyone is disconnected,
   the messages vanish and **the link will never work again**.

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
- **Self-destruct.** The host's key is ephemeral: it only exists in their tab's
  memory. Tab closed ⇒ key gone ⇒ nobody can ever connect to that address again,
  even with the link.
- **Star topology.** Each guest has a single tunnel, to the host, which relays the
  messages. Late joiners get the messages exchanged since the session started
  (kept in the host's memory, nowhere else).
- **Protocol.** Newline-delimited JSON over the TCP tunnel (see
  [`web/core.js`](web/core.js)). Heartbeats every 5 s: a participant silent for
  20 s is considered gone.

## What it protects, and what it doesn't

- ✅ Messages are end-to-end encrypted by WireGuard (+ PSK). Neither GitHub nor the
  relays can read them or join the session.
- ✅ Nothing is stored: no account, no database, no `localStorage`.
- ⚠️ **Anyone who gets the link can join** while the session exists. Send it over
  a channel you trust.
- ⚠️ In a browser, tailcat can't make direct connections: **all (encrypted)
  traffic goes through Tailscale's DERP relays**, which can therefore see who talks
  to whom (IP addresses, ephemeral public keys, traffic volume). These relays are
  free, rate-limited, and may be cut off at any time.
- ⚠️ The host relays messages: they pass through the host's tab in the clear (just
  like for any participant).
- ⚠️ tailcat is experimental with no API stability promises; the version used is
  pinned in [`build.sh`](build.sh).
- On mobile, if the host switches to another app, the browser may suspend the tab
  and the session drops.

## Development

Requirements: Go ≥ 1.27 and git.

```sh
./build.sh                    # compile tailcat to wasm + copy web/ → dist/
python3 -m http.server -d dist 8000
node test/e2e.mjs dist        # end-to-end test (host + guests in Node, real relays)
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
