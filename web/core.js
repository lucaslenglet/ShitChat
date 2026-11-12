// ShitChat protocol core. No DOM here, so it also runs under Node for tests.
//
// Topology: a star. The host's browser runs a tailcat server and a Hub.
// Every guest dials the host's tailcat address and gets one TCP stream
// over WireGuard. The Hub relays everything between participants. The
// host's own UI talks to the Hub in-process through the same message
// format, so the UI code doesn't care whether it's hosting or not.
//
// Wire format: newline-delimited JSON, one object per line, each with a
// string "t" (type) field.
//
// Guest -> hub:
//   {t:"hello", proto, resume?:{id, token}}  first message; resume = take my seat back
//   {t:"msg", text, cid}            send a chat message (cid = client id for echo matching)
//   {t:"typing", on}                typing indicator on/off
//   {t:"receipt", delivered, seen}  highest message ids received / seen
//   {t:"ping"}                      heartbeat
//   {t:"away"}                      my page is going away (reload?): keep my seat
//   {t:"bye"}                       leaving for good
//
// Hub -> guest:
//   {t:"welcome", proto, you:{id,name,token}, hostId, peers, messages}
//   {t:"roster", peers, event?:{kind:"join"|"back"|"lost"|"leave", id, name}}
//   {t:"msg", id, from, name, text, ts, cid?}
//   {t:"typing", from, on}
//   {t:"receipt", from, delivered, seen}
//   {t:"ping"}
//   {t:"away"}                      the host's page is going away (reload?): reconnect
//   {t:"replaced"}                  your seat was taken back by another connection
//   {t:"end"}                       the host destroyed the session
//
// Interruptions: a session survives the host or a guest dropping out
// (page reload, phone asleep, flaky network) for up to GRACE_MS. Guests
// keep redialing the host's address and get their seat back with their
// token; a reloaded host listens again with the same key (Hub.snapshot).
// Past GRACE_MS the session is over for good.
//
// Sessions surface extra events to the UI:
//   {t:"reconnecting", until}       lost the host, retrying until that time
//   {t:"closed", reason:"ended"|"left"|"lost"|"replaced"|"expired"}

export const PROTO = 2;
export const HOST_ID = 1;
export const MAX_TEXT = 4000;
// How long an interrupted session can come back.
export const GRACE_MS = 30 * 60_000;

const PING_EVERY_MS = 5_000;
const DEAD_AFTER_MS = 20_000;
const HELLO_TIMEOUT_MS = 15_000;
const MAX_LINE = 64 * 1024;
const BACKLOG = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clampInt = (v, lo, hi) =>
  Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : lo;

function randomToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Line wraps a tailcat conn ({read, write, close}) as an NDJSON channel.
// Writes are serialized: each conn.write runs on its own Go goroutine,
// so firing them concurrently could reorder messages on the wire.
class Line {
  constructor(conn) {
    this.conn = conn;
    this.queue = Promise.resolve();
    this.closed = false;
    this.lastRx = Date.now();
    this.enc = new TextEncoder();
  }

  send(obj) {
    if (this.closed) return Promise.resolve();
    const bytes = this.enc.encode(JSON.stringify(obj) + "\n");
    this.queue = this.queue
      .then(() => (this.closed ? undefined : this.conn.write(bytes)))
      .catch(() => this.close());
    return this.queue;
  }

  // read pumps incoming messages to onMessage until the stream ends,
  // fails, or close() is called. It resolves once the line is closed.
  async read(onMessage) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (let chunk; !this.closed && (chunk = await this.conn.read()) !== null; ) {
        this.lastRx = Date.now();
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while (!this.closed && (nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch {
            continue;
          }
          if (msg && typeof msg === "object" && typeof msg.t === "string") {
            try {
              onMessage(msg);
            } catch (err) {
              console.error("shitchat: handler error", err);
            }
          }
        }
        if (buf.length > MAX_LINE) break; // garbage or abuse: hang up
      }
    } catch {
      // read error: the connection is gone
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn.close();
    } catch {}
  }
}

const seat = ({ id, name, token, delivered, seen }) => ({ id, name, token, delivered, seen });

// Hub is the host-side relay. It owns the roster and the message
// backlog, which only live in the host's tab (and, to survive a reload,
// in that tab's sessionStorage: see snapshot).
export class Hub {
  // snapshot: what snapshot() returned before a reload, to pick the
  // session back up with the same key, backlog and seats.
  // onChange: called whenever there's something new to snapshot.
  constructor({ makeName, snapshot = null, onChange = () => {} }) {
    this.makeName = makeName;
    this.onChange = onChange;
    this.peers = new Map(); // connected: id -> {id, name, token, deliver, line, delivered, seen, typing}
    this.away = new Map(); // dropped out, may come back: id -> seat
    this.messages = [];
    this.nextPeerId = HOST_ID;
    this.nextMsgId = 1;
    this.keyJSON = "";
    if (snapshot) {
      this.keyJSON = snapshot.key;
      this.messages = snapshot.messages;
      this.nextPeerId = snapshot.nextPeerId;
      this.nextMsgId = snapshot.nextMsgId;
      for (const p of snapshot.peers) this.away.set(p.id, seat(p));
    }
    this.ended = false;
    this.ln = null;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), PING_EVERY_MS);
  }

  // listen starts the tailcat server and returns its "tc…" address.
  // Without a snapshot the key is fresh; with one, it's the same key, so
  // the same address and the invite link works again.
  async listen(tailcatListen, opts) {
    this.ln = await tailcatListen({
      ...opts,
      privateKey: this.keyJSON,
      onConnection: (c) => this.accept(c),
    });
    this.keyJSON = this.ln.privateKeyJSON;
    return this.ln.addr;
  }

  // snapshot is everything needed to resume the session after a reload.
  // It holds the tailcat private key: whoever has it can revive the link.
  snapshot() {
    return {
      key: this.keyJSON,
      nextPeerId: this.nextPeerId,
      nextMsgId: this.nextMsgId,
      messages: this.messages,
      peers: [...this.peers.values(), ...this.away.values()].map(seat),
    };
  }

  // openLocal attaches the host's own UI as a participant (it gets
  // HOST_ID because it's the first one, or takes it back after a
  // reload). Delivery is async and on copies, exactly like a remote
  // peer would see it.
  openLocal(onEvent) {
    const deliver = (m) => {
      const copy = JSON.parse(JSON.stringify(m));
      queueMicrotask(() => onEvent(copy));
    };
    const back = this.away.get(HOST_ID);
    this.away.delete(HOST_ID);
    const p = this.attach(deliver, null, back ?? null);
    this.local = p;
    return {
      send: (m) => this.handle(p, m),
      close: () => this.end(),
      pause: () => this.pause(),
    };
  }

  accept(conn) {
    if (this.ended) {
      conn.close();
      return;
    }
    const line = new Line(conn);
    let p = null;
    const timer = setTimeout(() => p || line.close(), HELLO_TIMEOUT_MS);
    line
      .read((m) => {
        if (p) {
          if (p.line === line) this.handle(p, m);
        } else if (m.t === "hello") {
          clearTimeout(timer);
          p = this.hello(line, m);
        } else {
          line.close();
        }
      })
      .then(() => {
        clearTimeout(timer);
        if (p) this.lost(p, line);
      });
  }

  hello(line, m) {
    if (this.ended) {
      line.close();
      return null;
    }
    const deliver = (x) => line.send(x);
    const r = m.resume;
    if (r && typeof r === "object" && Number.isInteger(r.id) && typeof r.token === "string") {
      const live = this.peers.get(r.id);
      if (live?.line && live.token === r.token) {
        // Same guest on a new connection before we noticed the old one
        // died (quick reload), or the same seat open in two tabs: the
        // newest connection wins, the old one is told to stand down.
        const old = live.line;
        live.line = line;
        live.deliver = deliver;
        Promise.race([old.send({ t: "replaced" }), sleep(1000)]).then(() => old.close());
        deliver(this.welcome(live));
        return live;
      }
      const back = this.away.get(r.id);
      if (back?.token && back.token === r.token) {
        this.away.delete(r.id);
        return this.attach(deliver, line, back);
      }
    }
    return this.attach(deliver, line, null);
  }

  // attach seats a participant: a new one, or one coming back.
  attach(deliver, line, back) {
    const p = back
      ? { ...back, deliver, line, typing: false }
      : {
          id: this.nextPeerId++,
          name: this.uniqueName(),
          token: line ? randomToken() : null,
          deliver,
          line,
          delivered: 0,
          seen: 0,
          typing: false,
        };
    this.peers.set(p.id, p);
    p.deliver(this.welcome(p));
    this.broadcast(
      {
        t: "roster",
        peers: this.roster(),
        event: { kind: back ? "back" : "join", id: p.id, name: p.name },
      },
      p.id,
    );
    this.onChange();
    return p;
  }

  welcome(p) {
    return {
      t: "welcome",
      proto: PROTO,
      you: { id: p.id, name: p.name, token: p.token },
      hostId: HOST_ID,
      peers: this.roster(),
      messages: this.messages,
    };
  }

  uniqueName() {
    const used = new Set([...this.peers.values(), ...this.away.values()].map((p) => p.name));
    for (let i = 0; i < 100; i++) {
      const n = this.makeName();
      if (!used.has(n)) return n;
    }
    return `${this.makeName()} ${this.nextPeerId}`;
  }

  handle(p, m) {
    if (this.ended || this.peers.get(p.id) !== p) return;
    switch (m.t) {
      case "msg": {
        if (typeof m.text !== "string") return;
        const text = m.text.slice(0, MAX_TEXT);
        if (!text.trim()) return;
        const msg = {
          t: "msg",
          id: this.nextMsgId++,
          from: p.id,
          name: p.name,
          text,
          ts: Date.now(),
        };
        if (typeof m.cid === "string") msg.cid = m.cid.slice(0, 64);
        this.messages.push(msg);
        if (this.messages.length > BACKLOG) this.messages.shift();
        p.typing = false;
        this.broadcast(msg);
        this.onChange();
        break;
      }
      case "typing": {
        const on = !!m.on;
        if (on === p.typing) return;
        p.typing = on;
        this.broadcast({ t: "typing", from: p.id, on }, p.id);
        break;
      }
      case "receipt": {
        const max = this.nextMsgId - 1;
        const seen = Math.max(p.seen, clampInt(m.seen, 0, max));
        const delivered = Math.max(p.delivered, clampInt(m.delivered, 0, max), seen);
        if (seen === p.seen && delivered === p.delivered) return;
        p.seen = seen;
        p.delivered = delivered;
        this.broadcast({ t: "receipt", from: p.id, delivered, seen }, p.id);
        this.onChange();
        break;
      }
      case "away":
        if (p.line) this.lost(p, p.line);
        break;
      case "bye":
        this.drop(p);
        break;
    }
  }

  // lost: the guest's connection is gone, but they may come back
  // (reload, flaky network): keep their seat.
  lost(p, line) {
    if (p.line !== line || this.peers.get(p.id) !== p) return;
    this.peers.delete(p.id);
    line.close();
    if (this.ended) return;
    this.away.set(p.id, seat(p));
    this.broadcast({
      t: "roster",
      peers: this.roster(),
      event: { kind: "lost", id: p.id, name: p.name },
    });
    this.onChange();
  }

  // drop: the guest left for good.
  drop(p) {
    if (this.peers.get(p.id) !== p) return;
    this.peers.delete(p.id);
    p.line?.close();
    if (this.ended) return;
    this.broadcast({
      t: "roster",
      peers: this.roster(),
      event: { kind: "leave", id: p.id, name: p.name },
    });
    this.onChange();
  }

  // tick sends heartbeats and drops guests we haven't heard from. A
  // closed browser tab sends no TCP FIN through the tunnel, so silence
  // is the only reliable signal that someone left.
  tick() {
    const now = Date.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > GRACE_MS) {
      // This page was frozen (phone asleep, tab in the background)
      // longer than guests keep trying: they're gone, end it for real.
      const local = this.local;
      this.end();
      local?.deliver({ t: "closed", reason: "expired" });
      return;
    }
    for (const p of [...this.peers.values()]) {
      if (!p.line) continue;
      if (now - p.line.lastRx > DEAD_AFTER_MS) this.lost(p, p.line);
      else p.line.send({ t: "ping" });
    }
  }

  broadcast(m, exceptId) {
    for (const p of this.peers.values()) {
      if (p.id !== exceptId) p.deliver(m);
    }
  }

  roster() {
    return [...this.peers.values()].map(({ id, name, delivered, seen }) => ({
      id,
      name,
      delivered,
      seen,
    }));
  }

  // pause: the host's page is going away. It may be a reload or the tab
  // closing, there's no telling which: have the guests start
  // reconnecting now instead of waiting for the heartbeat to time out.
  pause() {
    for (const p of this.peers.values()) p.line?.send({ t: "away" });
  }

  // end destroys the session: tell everyone, hang up, and stop the
  // tailcat server. The link can never be used again (as long as the
  // snapshot holding the key is thrown away too).
  async end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    const remotes = [...this.peers.values()].filter((p) => p.line);
    await Promise.race([
      Promise.all(remotes.map((p) => p.line.send({ t: "end" }))),
      sleep(1500),
    ]);
    for (const p of remotes) p.line.close();
    this.peers.clear();
    this.away.clear();
    this.messages = [];
    try {
      this.ln?.close();
    } catch {}
  }
}

// GuestSession is a guest's view of the session. If the connection to
// the host drops without the host ending the session, it keeps
// redialing for graceMs and takes its seat back.
export class GuestSession {
  constructor(tailcatDial, { addr, derpMapURL, verbose, resume = null, graceMs = GRACE_MS }, onEvent) {
    this.dial = () => tailcatDial({ addr, derpMapURL, verbose });
    this.resume = resume;
    this.graceMs = graceMs;
    this.onEvent = onEvent;
    this.line = null;
    this.done = false;
  }

  // connect makes one attempt, and rejects if the host can't be reached
  // (tailcat gives up after a minute).
  async connect() {
    const conn = await this.dial();
    if (this.done) {
      conn.close();
      return;
    }
    const line = new Line(conn);
    this.line = line;
    line.send({ t: "hello", proto: PROTO, resume: this.resume });
    this.run(line);
  }

  run(line) {
    let outcome = null;
    const timer = setInterval(() => {
      if (Date.now() - line.lastRx > DEAD_AFTER_MS) line.close();
      else line.send({ t: "ping" });
    }, PING_EVERY_MS);
    line
      .read((m) => {
        switch (m.t) {
          case "ping":
            return;
          case "end":
            outcome = "ended";
            return;
          case "replaced":
            outcome = "replaced";
            return line.close();
          case "away":
            return line.close(); // the host is reloading (or leaving)
          case "welcome":
            this.resume = { id: m.you.id, token: m.you.token };
            break;
        }
        this.onEvent(m);
      })
      .then(() => {
        clearInterval(timer);
        if (this.line === line) this.line = null;
        if (this.done) return;
        if (outcome) this.finish(outcome);
        else this.reconnect();
      });
  }

  async reconnect() {
    if (!this.resume) return this.finish("lost");
    const until = Date.now() + this.graceMs;
    this.onEvent({ t: "reconnecting", until });
    while (!this.done) {
      const left = until - Date.now();
      if (left <= 0) break;
      try {
        await Promise.race([
          this.connect(),
          sleep(left).then(() => Promise.reject(new Error("timeout"))),
        ]);
        return;
      } catch {}
      if (!this.done) await sleep(Math.min(2000, Math.max(0, until - Date.now())));
    }
    this.finish("lost");
  }

  finish(reason) {
    if (this.done) return;
    this.done = true;
    this.line?.close();
    this.onEvent({ t: "closed", reason });
  }

  // send is a no-op while reconnecting.
  send(m) {
    this.line?.send(m);
  }

  // away: our page is going away (reload?): ask the hub to keep our seat.
  away() {
    this.line?.send({ t: "away" });
  }

  // close leaves the session for good.
  async close() {
    if (this.done) return;
    this.done = true;
    const line = this.line;
    if (line) {
      await Promise.race([line.send({ t: "bye" }), sleep(1000)]);
      line.close();
    }
    this.onEvent({ t: "closed", reason: "left" });
  }
}

// join dials a host and returns a GuestSession. With opts.resume (a
// seat from an earlier welcome), it returns right away and keeps
// trying for graceMs; otherwise it makes a single attempt and rejects
// if the host can't be reached.
export async function join(tailcatDial, opts, onEvent) {
  const s = new GuestSession(tailcatDial, opts, onEvent);
  if (opts.resume) s.reconnect();
  else await s.connect();
  return s;
}
