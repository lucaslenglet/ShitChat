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
//   {t:"msg", text, cid}            send a chat message (cid = client id for echo matching)
//   {t:"typing", on}                typing indicator on/off
//   {t:"receipt", delivered, seen}  highest message ids received / seen
//   {t:"ping"}                      heartbeat
//   {t:"bye"}                       leaving
//
// Hub -> guest:
//   {t:"welcome", proto, you:{id,name}, hostId, peers, messages}
//   {t:"roster", peers, event?:{kind:"join"|"leave", id, name}}
//   {t:"msg", id, from, name, text, ts, cid?}
//   {t:"typing", from, on}
//   {t:"receipt", from, delivered, seen}
//   {t:"ping"}
//   {t:"end"}                       the host destroyed the session
//
// Sessions surface one extra event to the UI when they stop:
//   {t:"closed", reason:"ended"|"left"|"lost"}

export const PROTO = 1;
export const HOST_ID = 1;
export const MAX_TEXT = 4000;

const PING_EVERY_MS = 5_000;
const DEAD_AFTER_MS = 20_000;
const MAX_LINE = 64 * 1024;
const BACKLOG = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clampInt = (v, lo, hi) =>
  Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : lo;

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
        while ((nl = buf.indexOf("\n")) >= 0) {
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

// Hub is the host-side relay. It owns the roster and the in-memory
// message backlog, which vanish with the host's tab.
export class Hub {
  constructor({ makeName }) {
    this.makeName = makeName;
    this.peers = new Map(); // id -> {id, name, deliver, line, delivered, seen, typing}
    this.messages = [];
    this.nextPeerId = HOST_ID;
    this.nextMsgId = 1;
    this.ended = false;
    this.ln = null;
    this.timer = setInterval(() => this.tick(), PING_EVERY_MS);
  }

  // listen starts the tailcat server and returns its "tc…" address.
  async listen(tailcatListen, opts) {
    this.ln = await tailcatListen({ ...opts, onConnection: (c) => this.accept(c) });
    return this.ln.addr;
  }

  // openLocal attaches the host's own UI as a participant (it gets
  // HOST_ID because it's the first one). Delivery is async and on
  // copies, exactly like a remote peer would see it.
  openLocal(onEvent) {
    const p = this.addPeer((m) => {
      const copy = JSON.parse(JSON.stringify(m));
      queueMicrotask(() => onEvent(copy));
    }, null);
    return {
      send: (m) => this.handle(p, m),
      close: () => this.end(),
    };
  }

  accept(conn) {
    if (this.ended) {
      conn.close();
      return;
    }
    const line = new Line(conn);
    const p = this.addPeer((m) => line.send(m), line);
    line.read((m) => this.handle(p, m)).then(() => this.drop(p));
  }

  addPeer(deliver, line) {
    const p = {
      id: this.nextPeerId++,
      name: this.uniqueName(),
      deliver,
      line,
      delivered: 0,
      seen: 0,
      typing: false,
    };
    this.peers.set(p.id, p);
    p.deliver({
      t: "welcome",
      proto: PROTO,
      you: { id: p.id, name: p.name },
      hostId: HOST_ID,
      peers: this.roster(),
      messages: this.messages,
    });
    this.broadcast(
      { t: "roster", peers: this.roster(), event: { kind: "join", id: p.id, name: p.name } },
      p.id,
    );
    return p;
  }

  uniqueName() {
    const used = new Set([...this.peers.values()].map((p) => p.name));
    for (let i = 0; i < 100; i++) {
      const n = this.makeName();
      if (!used.has(n)) return n;
    }
    return `${this.makeName()} ${this.nextPeerId}`;
  }

  handle(p, m) {
    if (this.ended || !this.peers.has(p.id)) return;
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
        break;
      }
      case "bye":
        this.drop(p);
        break;
    }
  }

  drop(p) {
    if (!this.peers.delete(p.id)) return;
    p.line?.close();
    if (this.ended) return;
    this.broadcast({
      t: "roster",
      peers: this.roster(),
      event: { kind: "leave", id: p.id, name: p.name },
    });
  }

  // tick sends heartbeats and drops guests we haven't heard from. A
  // closed browser tab sends no TCP FIN through the tunnel, so silence
  // is the only reliable signal that someone left.
  tick() {
    const now = Date.now();
    for (const p of [...this.peers.values()]) {
      if (!p.line) continue;
      if (now - p.line.lastRx > DEAD_AFTER_MS) this.drop(p);
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

  // end destroys the session: tell everyone, hang up, and stop the
  // tailcat server. Its ephemeral key is gone with it, so the shared
  // link can never be used again.
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
    this.messages = [];
    try {
      this.ln?.close();
    } catch {}
  }
}

// RemoteSession is a guest's view of the session over a tailcat conn.
export class RemoteSession {
  constructor(conn, onEvent) {
    this.line = new Line(conn);
    this.onEvent = onEvent;
    this.gotEnd = false;
    this.left = false;
  }

  start() {
    this.timer = setInterval(() => {
      if (Date.now() - this.line.lastRx > DEAD_AFTER_MS) this.line.close();
      else this.line.send({ t: "ping" });
    }, PING_EVERY_MS);
    this.line
      .read((m) => {
        if (m.t === "end") this.gotEnd = true;
        else if (m.t !== "ping") this.onEvent(m);
      })
      .then(() => {
        clearInterval(this.timer);
        const reason = this.gotEnd ? "ended" : this.left ? "left" : "lost";
        this.onEvent({ t: "closed", reason });
      });
  }

  send(m) {
    this.line.send(m);
  }

  async close() {
    this.left = true;
    await Promise.race([this.line.send({ t: "bye" }), sleep(1000)]);
    this.line.close();
  }
}

// join dials a host and returns a started RemoteSession.
export async function join(tailcatDial, opts, onEvent) {
  const conn = await tailcatDial(opts);
  const s = new RemoteSession(conn, onEvent);
  s.start();
  return s;
}
