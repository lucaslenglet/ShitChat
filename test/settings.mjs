// Offline test of the session settings (max people, who can write, who
// can send files), over an in-memory stand-in for tailcat: no wasm, no
// network, a few seconds.
//
// Usage: node test/settings.mjs

import { Hub, join, cleanSettings, HOST_ID } from "../web/core.js";

// ---- Fake tailcat: a listener per address, conns are in-memory pipes ----
const listeners = new Map();

function pipe() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(b) {
      if (closed) return;
      queue.push(b);
      wake?.();
    },
    end() {
      closed = true;
      wake?.();
    },
    async read() {
      while (!queue.length && !closed) await new Promise((r) => (wake = r));
      wake = null;
      return queue.length ? queue.shift() : null;
    },
  };
}

function connPair() {
  const ab = pipe();
  const ba = pipe();
  const close = () => {
    ab.end();
    ba.end();
  };
  return [
    { read: () => ba.read(), write: async (b) => ab.push(b.slice()), close },
    { read: () => ab.read(), write: async (b) => ba.push(b.slice()), close },
  ];
}

let nextAddr = 0;
const tailcatListen = async ({ onConnection }) => {
  const addr = `tcfake${nextAddr++}`;
  listeners.set(addr, onConnection);
  return { addr, privateKeyJSON: "{}", close: () => listeners.delete(addr) };
};
const tailcatDial = async ({ addr }) => {
  const accept = listeners.get(addr);
  if (!accept) throw new Error("no such host");
  const [guest, host] = connPair();
  accept(host);
  return guest;
};

// ---- Tiny test kit (same as e2e.mjs) ----
let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`);
  if (!cond) failures++;
};

function recorder(label) {
  const events = [];
  const waiters = [];
  const fn = (m) => {
    events.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  };
  fn.events = events;
  fn.wait = (pred, ms = 3000, what = "event") =>
    new Promise((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`${label}: timed out waiting for ${what}`));
      }, ms);
    });
  return fn;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---- cleanSettings ----
  const d = cleanSettings(undefined);
  ok(d.maxPeople === 0 && d.chat === "all" && d.files === "all" && d.autoload === false, "defaults are the old behavior, files on demand");
  const c = cleanSettings({ maxPeople: 1, chat: "x", files: "host", autoload: "yes" });
  ok(c.maxPeople === 2 && c.chat === "all" && c.files === "host" && c.autoload === false, "settings are sanitized");
  ok(cleanSettings({ maxPeople: 1e9 }).maxPeople === 100, "max people is capped");

  // ---- Max people ----
  let n = 0;
  const hub = new Hub({
    makeName: () => `P${n++}`,
    settings: { maxPeople: 3, chat: "host", files: "host" },
  });
  const addr = await hub.listen(tailcatListen, {});
  const H = recorder("host");
  const host = hub.openLocal(H);
  const hw = await H.wait((m) => m.t === "welcome");
  ok(hw.settings.maxPeople === 3 && hw.settings.chat === "host", "the host's welcome carries the settings");

  const A = recorder("A");
  const a = await join(tailcatDial, { addr }, A);
  const aw = await A.wait((m) => m.t === "welcome");
  ok(aw.settings.files === "host", "a guest's welcome carries the settings");
  const B = recorder("B");
  const b = await join(tailcatDial, { addr }, B);
  await B.wait((m) => m.t === "welcome");
  const C = recorder("C");
  await join(tailcatDial, { addr }, C);
  const cc = await C.wait((m) => m.t === "closed");
  ok(cc.reason === "full" && !C.events.some((m) => m.t === "welcome"), "the 4th person is turned away: full");

  // A guest who drops out keeps their seat…
  const seatA = a.resume;
  a.away();
  a.done = true;
  await H.wait((m) => m.t === "roster" && m.event?.kind === "lost");
  const D = recorder("D");
  await join(tailcatDial, { addr }, D);
  ok((await D.wait((m) => m.t === "closed")).reason === "full", "a dropped-out guest's seat stays taken");
  const A2 = recorder("A2");
  const a2 = await join(tailcatDial, { addr, resume: seatA }, A2);
  await A2.wait((m) => m.t === "welcome");
  ok(true, "…and they can take it back even though the session is full");

  // …and one who leaves frees it.
  await b.close();
  await H.wait((m) => m.t === "roster" && m.event?.kind === "leave");
  const E = recorder("E");
  const e = await join(tailcatDial, { addr }, E);
  await E.wait((m) => m.t === "welcome");
  ok(true, "someone who leaves frees their seat");

  // ---- Only the host can write / send files ----
  a2.send({ t: "msg", text: "guest talking", cid: "g1" });
  a2.send({ t: "typing", on: true });
  host.send({ t: "msg", text: "host talking", cid: "h1" });
  await E.wait((m) => m.t === "msg" && m.cid === "h1");
  await sleep(100);
  ok(!E.events.some((m) => m.t === "msg" && m.cid === "g1"), "a guest's message is dropped when only the host writes");
  ok(!E.events.some((m) => m.t === "typing"), "and so is their typing indicator");

  let refused = null;
  await a2.putFile("gf", new File([new Uint8Array(10)], "x.bin")).catch((err) => (refused = err));
  ok(refused?.refused && refused.message === "not-allowed", "a guest's file is refused when only the host sends files");
  const hf = await host.putFile("hf", new File([new Uint8Array(10)], "y.bin"));
  const ef = await E.wait((m) => m.t === "msg" && m.cid === "hf");
  const blob = await e.getFile(ef.id, ef.file);
  ok(hf.from === HOST_ID && blob.size === 10, "the host can still send files");

  // ---- Settings survive a host reload ----
  const snap = JSON.parse(JSON.stringify(hub.snapshot()));
  const hubR = new Hub({ makeName: () => "R", snapshot: snap });
  ok(hubR.settings.maxPeople === 3 && hubR.settings.chat === "host", "settings are in the snapshot");
  clearInterval(hubR.timer);
  await host.close();

  // ---- Defaults: everyone can write and send ----
  const hub2 = new Hub({ makeName: () => `Q${n++}` });
  const addr2 = await hub2.listen(tailcatListen, {});
  const host2 = hub2.openLocal(() => {});
  const F = recorder("F");
  const f = await join(tailcatDial, { addr: addr2 }, F);
  await F.wait((m) => m.t === "welcome");
  f.send({ t: "msg", text: "hi", cid: "f1" });
  await F.wait((m) => m.t === "msg" && m.cid === "f1");
  const ff = await f.putFile("ff", new File([new Uint8Array(5)], "z.bin"));
  ok(ff.file.size === 5, "by default guests can write and send files");
  await host2.close();

  // ---- History hidden, file size, receipts and typing off ----
  const hub3 = new Hub({
    makeName: () => `S${n++}`,
    settings: { history: "none", maxFile: 2 << 20, receipts: false, typing: false },
  });
  ok(hub3.settings.maxFile === 2 << 20, "max file size is kept");
  const addr3 = await hub3.listen(tailcatListen, {});
  const host3 = hub3.openLocal(() => {});
  host3.send({ t: "msg", text: "before", cid: "b1" });
  const early = await host3.putFile("bf", new File([new Uint8Array(4)], "early.bin"));
  const G = recorder("G");
  const g = await join(tailcatDial, { addr: addr3 }, G);
  const gw = await G.wait((m) => m.t === "welcome");
  ok(gw.messages.length === 0, "a newcomer doesn't get the backlog when the history is hidden");
  let hidden = null;
  await g.getFile(early.id, early.file).catch((err) => (hidden = err));
  ok(hidden?.gone, "nor the files posted before they joined");
  host3.send({ t: "msg", text: "after", cid: "a1" });
  await G.wait((m) => m.t === "msg" && m.cid === "a1");
  ok(true, "but gets what's posted after");
  let tooBig = null;
  await g.putFile("tb", new File([new Uint8Array((2 << 20) + 1)], "big.bin")).catch((err) => (tooBig = err));
  ok(tooBig?.message === "too-big", "a file over the host's limit is refused");
  const I = recorder("I");
  const i = await join(tailcatDial, { addr: addr3 }, I);
  await I.wait((m) => m.t === "welcome");
  g.send({ t: "typing", on: true });
  g.send({ t: "receipt", delivered: 3, seen: 3 });
  g.send({ t: "msg", text: "x", cid: "gx" });
  await I.wait((m) => m.t === "msg" && m.cid === "gx");
  await sleep(100);
  ok(!I.events.some((m) => m.t === "typing" || m.t === "receipt"), "typing and receipts are dropped when off");

  // ---- Lock and kick ----
  host3.send({ t: "set", settings: { locked: true } });
  const lk = await G.wait((m) => m.t === "settings");
  ok(lk.settings.locked, "everyone is told the session is locked");
  const J = recorder("J");
  await join(tailcatDial, { addr: addr3 }, J);
  ok((await J.wait((m) => m.t === "closed")).reason === "locked", "a newcomer is turned away when locked");
  const seatG = g.resume;
  g.away();
  g.done = true;
  await I.wait((m) => m.t === "roster" && m.event?.kind === "lost");
  const G2 = recorder("G2");
  const g2 = await join(tailcatDial, { addr: addr3, resume: seatG }, G2);
  await G2.wait((m) => m.t === "welcome");
  ok(true, "a seat can still be taken back when locked");
  i.send({ t: "kick", id: seatG.id });
  await sleep(100);
  ok(hub3.peers.has(seatG.id), "a guest can't kick anyone");
  host3.send({ t: "kick", id: seatG.id });
  ok((await G2.wait((m) => m.t === "closed")).reason === "kicked", "the host can kick a guest");
  const kev = await I.wait((m) => m.t === "roster" && m.event?.kind === "kicked");
  ok(kev.peers.length === 2, "the others see them removed");
  const G3 = recorder("G3");
  await join(tailcatDial, { addr: addr3, resume: seatG }, G3);
  ok((await G3.wait((m) => m.t === "closed")).reason === "kicked", "a kicked seat can't be taken back");
  host3.send({ t: "set", settings: { locked: false } });
  const K = recorder("K");
  const k = await join(tailcatDial, { addr: addr3 }, K);
  await K.wait((m) => m.t === "welcome");
  ok(true, "unlocked: newcomers get in again");

  // ---- Changing the settings during the session ----
  i.send({ t: "set", settings: { chat: "host" } });
  await sleep(100);
  ok(hub3.settings.chat === "all", "a guest can't change the settings");
  host3.send({ t: "set", settings: { typing: true } });
  await K.wait((m) => m.t === "settings" && m.settings.typing);
  k.send({ t: "typing", on: true });
  await I.wait((m) => m.t === "typing" && m.on);
  host3.send({ t: "set", settings: { chat: "host", maxPeople: 1, bogus: 1 } });
  const st = await K.wait((m) => m.t === "settings" && m.settings.chat === "host");
  ok(st.settings.maxPeople === 2 && !("bogus" in st.settings), "changes are sanitized and sent to everyone");
  await I.wait((m) => m.t === "typing" && !m.on);
  ok(true, "whoever may no longer write stops typing");
  k.send({ t: "msg", text: "nope", cid: "kn" });
  await sleep(100);
  ok(!I.events.some((m) => m.t === "msg" && m.cid === "kn"), "the new rules apply right away");
  const before = K.events.filter((m) => m.t === "settings").length;
  host3.send({ t: "set", settings: { chat: "host" } });
  await sleep(100);
  ok(K.events.filter((m) => m.t === "settings").length === before, "a no-op change isn't broadcast");
  host3.send({ t: "set", settings: { receipts: true } });
  await K.wait((m) => m.t === "roster" && !m.event);
  ok(true, "receipts back on: everyone gets the roster again");
  const snap3 = JSON.parse(JSON.stringify(hub3.snapshot()));
  ok(snap3.kicked.includes(seatG.id), "kicked ids are in the snapshot");
  await host3.close();
} catch (err) {
  console.log("  FAIL", err.message);
  failures++;
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
