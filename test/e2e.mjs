// End-to-end test of the chat protocol over real tailcat tunnels.
//
// Runs the actual tailcat WebAssembly build under Node (which has fetch
// and WebSocket, all the wasm needs) and drives web/core.js: one host Hub
// and two guests, talking through Tailscale's public DERP relays.
//
// Usage: node test/e2e.mjs [dist-dir]   (default: dist, built by ./build.sh)
// Needs network access. Takes ~1.5 min (the dead-link check waits for
// tailcat's 60 s dial timeout).

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { join as pathJoin, resolve } from "node:path";
import { Hub, join } from "../web/core.js";

const dist = resolve(process.argv[2] ?? "dist");
const derpMapURL = "https://tailcat.dev/derpmap.json";

// ---- Boot tailcat wasm ----
// Go's js/wasm net/http refuses the Fetch API when process.argv0 starts
// with "node" (it assumes there's no fetch there). Node has had fetch for
// years, and we need it to download the DERP map like a browser would.
// argv0 is read-only and non-configurable, and Go reads it once at package
// init, so shadow it with an object inheriting from process while the wasm
// boots.
const realProcess = globalThis.process;
globalThis.process = Object.create(realProcess, { argv0: { value: "shitchat-e2e" } });
createRequire(import.meta.url)(pathJoin(dist, "wasm_exec.js"));
const ready = new Promise((r) => (globalThis.onTailcatReady = r));
const go = new Go();
const wasm = gunzipSync(readFileSync(pathJoin(dist, "main.wasm.gz")));
const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
go.run(instance);
await ready;
globalThis.process = realProcess;
const { tailcatListen, tailcatDial } = globalThis;

// ---- Tiny test kit ----
let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`);
  if (!cond) failures++;
};

// recorder collects events and lets tests wait for a matching one.
function recorder(label) {
  const events = [];
  const waiters = [];
  const remove = (w) => {
    const i = waiters.indexOf(w);
    if (i >= 0) waiters.splice(i, 1);
  };
  const fn = (m) => {
    events.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        remove(w);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  };
  fn.events = events;
  fn.wait = (pred, ms = 15000, what = "event") =>
    new Promise((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      w.timer = setTimeout(() => {
        remove(w);
        reject(new Error(`${label}: timed out waiting for ${what}`));
      }, ms);
    });
  return fn;
}

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

try {
  // ---- Host ----
  let n = 0;
  const hub = new Hub({ makeName: () => ["Host", "Alice", "Bob", "Carol"][n++] });
  const addr = await hub.listen(tailcatListen, { derpMapURL });
  ok(addr.startsWith("tc"), `host listening (${addr.length}-char address) [${elapsed()}]`);
  const H = recorder("host");
  const host = hub.openLocal(H);
  const hw = await H.wait((m) => m.t === "welcome");
  ok(hw.you.id === 1 && hw.you.name === "Host", "host gets welcome as id 1");

  // ---- Guest A ----
  const A = recorder("A");
  const a = await join(tailcatDial, { addr, derpMapURL }, A);
  const aw = await A.wait((m) => m.t === "welcome");
  ok(aw.you.name === "Alice" && aw.peers.length === 2, `A joined as Alice, sees 2 peers [${elapsed()}]`);
  await H.wait((m) => m.t === "roster" && m.event?.kind === "join" && m.event.name === "Alice");
  ok(true, "host sees Alice join");

  // ---- Guest B ----
  const B = recorder("B");
  const b = await join(tailcatDial, { addr, derpMapURL }, B);
  const bw = await B.wait((m) => m.t === "welcome");
  ok(bw.you.name === "Bob" && bw.peers.length === 3, `B joined as Bob, sees 3 peers [${elapsed()}]`);
  await A.wait((m) => m.t === "roster" && m.event?.name === "Bob");
  ok(true, "A sees Bob join");

  // ---- Typing ----
  a.send({ t: "typing", on: true });
  await B.wait((m) => m.t === "typing" && m.from === aw.you.id && m.on);
  await H.wait((m) => m.t === "typing" && m.from === aw.you.id && m.on);
  ok(true, "B and host see Alice typing");

  // ---- Messages ----
  a.send({ t: "msg", text: "salut 👋", cid: "c1" });
  const echo = await A.wait((m) => m.t === "msg" && m.cid === "c1");
  ok(echo.id === 1 && echo.name === "Alice", "Alice gets her message echoed with id 1");
  const bm = await B.wait((m) => m.t === "msg" && m.id === 1);
  ok(bm.text === "salut 👋", "Bob receives the exact text");
  await H.wait((m) => m.t === "msg" && m.id === 1);
  ok(true, "host receives it too");

  host.send({ t: "msg", text: "bienvenue", cid: "h1" });
  await A.wait((m) => m.t === "msg" && m.text === "bienvenue");
  await B.wait((m) => m.t === "msg" && m.text === "bienvenue");
  ok(true, "host's message reaches both guests");

  // Ordering: a burst must arrive in order.
  for (let i = 0; i < 20; i++) a.send({ t: "msg", text: `n${i}` });
  await B.wait((m) => m.t === "msg" && m.text === "n19");
  const burst = B.events.filter((m) => m.t === "msg" && /^n\d+$/.test(m.text)).map((m) => m.text);
  ok(burst.join() === [...Array(20)].map((_, i) => `n${i}`).join(), "burst of 20 messages arrives in order");

  // Validation: empty and oversized messages.
  a.send({ t: "msg", text: "   " });
  a.send({ t: "msg", text: "x".repeat(10000), cid: "big" });
  const big = await A.wait((m) => m.t === "msg" && m.cid === "big");
  ok(big.text.length === 4000, "oversized message is truncated to 4000 chars");
  ok(!A.events.some((m) => m.t === "msg" && m.text === "   "), "blank message is dropped");

  // ---- Receipts ----
  b.send({ t: "receipt", delivered: 2, seen: 1 });
  const r = await A.wait((m) => m.t === "receipt" && m.from === bw.you.id);
  ok(r.delivered === 2 && r.seen === 1, "Alice sees Bob's receipt (delivered 2, seen 1)");
  b.send({ t: "receipt", delivered: 999, seen: 999 });
  const r2 = await A.wait((m) => m.t === "receipt" && m.from === bw.you.id && m.seen > 1);
  ok(r2.seen === hub.nextMsgId - 1, "receipt ids are clamped to the last real message");

  // ---- Late joiner gets the backlog ----
  const C = recorder("C");
  const c = await join(tailcatDial, { addr, derpMapURL }, C);
  const cw = await C.wait((m) => m.t === "welcome");
  ok(cw.messages.length === hub.messages.length && cw.messages[0].text === "salut 👋", "late joiner gets the backlog");
  ok(cw.peers.find((p) => p.id === bw.you.id)?.seen === r2.seen, "late joiner sees existing receipts");

  // ---- Leaving ----
  await b.close();
  const bc = await B.wait((m) => m.t === "closed");
  ok(bc.reason === "left", "Bob's session reports 'left'");
  const leave = await A.wait((m) => m.t === "roster" && m.event?.kind === "leave" && m.event.name === "Bob");
  ok(leave.peers.length === 3, "Alice sees Bob leave (3 peers left)");

  // ---- Host destroys the session ----
  await host.close();
  const ac = await A.wait((m) => m.t === "closed");
  const cc = await C.wait((m) => m.t === "closed");
  ok(ac.reason === "ended" && cc.reason === "ended", `guests are told the session ended [${elapsed()}]`);

  // ---- The link is dead forever ----
  console.log("  …   dialing the dead link (waits for the 60 s dial timeout)");
  let dialed = false;
  try {
    const conn = await tailcatDial({ addr, derpMapURL });
    dialed = true;
    conn.close();
  } catch {}
  ok(!dialed, `dead link can't be dialed anymore [${elapsed()}]`);

  // ---- Host vanishes without saying goodbye (tab killed) ----
  const hub2 = new Hub({ makeName: () => "X" + Math.random() });
  const addr2 = await hub2.listen(tailcatListen, { derpMapURL });
  hub2.openLocal(() => {});
  const D = recorder("D");
  await join(tailcatDial, { addr: addr2, derpMapURL }, D);
  await D.wait((m) => m.t === "welcome");
  clearInterval(hub2.timer); // no more heartbeats…
  hub2.ln.close(); // …and the tailcat server is gone, no "end" sent
  console.log(`  …   host vanished, waiting for the guest to notice [${elapsed()}]`);
  const dc = await D.wait((m) => m.t === "closed", 40000, "closed after host vanished");
  ok(dc.reason === "lost", `guest notices a vanished host ('lost') [${elapsed()}]`);
} catch (err) {
  console.log("  FAIL", err.message);
  failures++;
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
