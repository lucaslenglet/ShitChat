// ShitChat protocol core. No DOM here, so it also runs under Node for tests.
//
// Topology: a star. The host's browser runs a tailcat server and a Hub.
// Every guest dials the host's tailcat address and gets one TCP stream
// over WireGuard. The Hub relays everything between participants. The
// host's own UI talks to the Hub in-process through the same message
// format, so the UI code doesn't care whether it's hosting or not.
//
// Wire format: newline-delimited JSON, one object per line, each with a
// string "t" (type) field. A line with a "bin": n field is followed by n
// raw bytes (file contents), handed to the handler as msg.data.
//
// Guest -> hub:
//   {t:"hello", proto, resume?:{id, token}, password?}
//                                   first message; resume = take my seat back.
//                                   Sent again with a password after an "auth".
//   {t:"msg", text, cid}            send a chat message (cid = client id for echo matching)
//   {t:"fput", cid, name, type, size}
//                                   start sending a file (replaces my unfinished one)
//   {t:"fchunk", cid, bin} + bytes  the next piece of it; once size bytes are
//                                   in, the hub posts it as a message with that cid
//   {t:"fget", id}                  send me the contents of the file in message id
//   {t:"typing", on}                typing indicator on/off
//   {t:"receipt", delivered, seen}  highest message ids received / seen
//   {t:"set", settings}             host only: change some settings (a partial
//                                   object, see cleanSettings), e.g. {locked:true}
//   {t:"kick", id}                  host only: throw that participant out
//   {t:"ping"}                      heartbeat
//   {t:"away"}                      my page is going away (reload?): keep my seat
//   {t:"bye"}                       leaving for good
//
// Hub -> guest:
//   {t:"auth", wrong}               this session needs a password (wrong: the one
//                                   sent didn't match): send another hello
//   {t:"denied"}                    too many wrong passwords, or too slow: bye
//   {t:"full"}                      the session has reached its max people: bye
//   {t:"locked"}                    the host isn't letting anyone new in: bye
//   {t:"kicked"}                    the host threw you out: bye
//   {t:"welcome", proto, you:{id,name,token}, hostId, peers, messages, settings,
//    password}                     password: whether the link alone isn't enough
//   {t:"roster", peers, event?:{kind:"join"|"back"|"lost"|"leave"|"kicked", id, name}}
//   {t:"settings", settings}        the host changed some settings (all of them
//                                   are sent; the UI tells what changed)
//   {t:"msg", id, from, name, text, ts, cid?, file?:{name, type, size}}
//   {t:"fdata", id, off, bin} + bytes  a piece of a file asked with fget
//   {t:"fgone", id}                 the hub doesn't have that file (anymore), or
//                                   it was posted before you joined and the
//                                   history is hidden from newcomers
//   {t:"ferr", cid, reason}         a file was refused ("too-big", "not-allowed")
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
//   {t:"closed", reason:"ended"|"left"|"lost"|"replaced"|"expired"|"denied"|"full"
//                       |"locked"|"kicked"|"destroyed"}
//                                   ("destroyed": the host's own UI, after close)
//
// Password: a session can require one. The hub keeps only a salted
// PBKDF2 hash of it. The password travels inside the WireGuard tunnel,
// like everything else. A guest taking their seat back with a valid
// token doesn't need it again. Wrong guesses are slowed down hub-wide
// (one every WRONG_PASSWORD_DELAY_MS at most) and a connection gets
// MAX_PASSWORD_TRIES before being hung up on.
//
// Files: the sender streams them to the hub, which keeps them in memory
// only (never in the snapshot: a reloaded host has lost them) and posts a
// message with the file's name, type and size. Each participant then asks
// for the contents (fget). Files travel as raw bytes after their JSON
// line, at a lower priority than everything else, so chat keeps flowing
// during a transfer.
//
// Settings: the host picks them when creating the session (see
// cleanSettings) and can change any of them during it ("set"); the hub
// enforces them. Guests get them in the welcome, then a "settings" on
// every change, so their UI can follow. A change only applies from then
// on: lowering maxPeople throws nobody out, history only concerns the
// next newcomers, maxFile only the next files. The host itself is never restricted
// by chat and files; the others apply to everyone.
//   maxPeople  0 = no limit, else how many seats in all (host included;
//              a guest who dropped out keeps their seat for GRACE_MS)
//   chat       "all" | "host": who can send messages
//   files      "all" | "host": who can send files
//   maxFile    the largest file accepted, in bytes (at most MAX_FILE)
//   history    "all": newcomers get the backlog; "none": only what's
//              posted after they joined (files included)
//   receipts   false: no delivered / seen at all (the hub drops them)
//   typing     false: no "X is typing" (the hub drops them)
//   autoload   false: received files are fetched when asked for (default)
//              true: right away (a UI matter, the hub doesn't care)
//   locked     nobody new can join (meant to be toggled during the session)
//
// Kicking: the host can throw a participant out. Their seat is gone and
// their id is remembered, so their tab can't quietly sneak back in with
// its old seat; opening the link again is a new arrival (lock to stop it).

export const PROTO = 6;
export const HOST_ID = 1;
export const MAX_TEXT = 4000;
// How long an interrupted session can come back.
export const GRACE_MS = 30 * 60_000;
export const MAX_FILE = 50 << 20;
// What the hub keeps at most, all files together: the oldest go first.
const MAX_STORE = 150 << 20;
const CHUNK = 32 << 10;
const MAX_BIN = 64 << 10;
const MAX_STREAMS = 3; // files sent at once to one participant

const PING_EVERY_MS = 5_000;
const DEAD_AFTER_MS = 20_000;
const HELLO_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 5 * 60_000; // time to type the password
const MAX_PASSWORD_TRIES = 3;
const WRONG_PASSWORD_DELAY_MS = 1_000;
const MAX_PASSWORD = 1024;
const PBKDF2_ITERATIONS = 100_000;
const MAX_LINE = 64 * 1024;
const BACKLOG = 500;

export const DEFAULT_SETTINGS = Object.freeze({
  maxPeople: 0,
  chat: "all",
  files: "all",
  maxFile: MAX_FILE,
  history: "all",
  receipts: true,
  typing: true,
  autoload: false,
  locked: false,
});
export const MAX_PEOPLE = 100;

// allowed tells whether participant id may send ("chat" or "files"):
// the host always may.
export const allowed = (settings, id, what) => id === HOST_ID || settings[what] === "all";
const MIN_MAX_FILE = 1 << 20;

// cleanSettings fills in and checks what the host asked for.
export function cleanSettings(s) {
  if (!s || typeof s !== "object") s = {};
  const n = Number(s.maxPeople);
  const f = Number(s.maxFile);
  return {
    maxPeople: Number.isInteger(n) && n > 0 ? Math.min(MAX_PEOPLE, Math.max(2, n)) : 0,
    chat: s.chat === "host" ? "host" : "all",
    files: s.files === "host" ? "host" : "all",
    maxFile: Number.isInteger(f) && f > 0 ? Math.min(MAX_FILE, Math.max(MIN_MAX_FILE, f)) : MAX_FILE,
    history: s.history === "none" ? "none" : "all",
    receipts: s.receipts !== false,
    typing: s.typing !== false,
    autoload: s.autoload === true,
    locked: s.locked === true,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clampInt = (v, lo, hi) =>
  Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : lo;

// cleanFile sanitizes the file metadata a sender gave.
function cleanFile(m) {
  let name = typeof m.name === "string" ? m.name : "";
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200) || "file";
  const type =
    typeof m.type === "string" && /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/.test(m.type)
      ? m.type.toLowerCase()
      : "application/octet-stream";
  return { name, type, size: m.size };
}

const hex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");

function randomToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b);
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return hex(bits);
}

// makeSecret turns a session password into what the hub keeps: a salted
// hash, so the password itself is never stored (people reuse them).
export async function makeSecret(password) {
  const salt = randomToken();
  return { salt, hash: await pbkdf2(password, salt) };
}

async function checkSecret(secret, password) {
  const h = await pbkdf2(password, secret.salt);
  let diff = h.length ^ secret.hash.length;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ secret.hash.charCodeAt(i);
  return diff === 0;
}

// Line wraps a tailcat conn ({read, write, close}) as an NDJSON channel.
// Writes are serialized: each conn.write runs on its own Go goroutine,
// so firing them concurrently could reorder messages on the wire. Bulk
// writes (file pieces) wait for the regular ones to be out.
// concat joins two byte arrays (b itself if a is empty).
function concat(a, b) {
  if (!a.byteLength) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

// Errors the UI tells apart: the hub refused a file, or doesn't have it.
const refused = (reason) => Object.assign(new Error(reason), { refused: true });
const gone = () => Object.assign(new Error("gone"), { gone: true });

class Line {
  constructor(conn) {
    this.conn = conn;
    this.urgent = [];
    this.bulk = [];
    this.writing = false;
    this.closed = false;
    this.lastRx = Date.now();
    this.enc = new TextEncoder();
  }

  frame(obj, data) {
    if (!data) return this.enc.encode(JSON.stringify(obj) + "\n");
    const head = this.enc.encode(JSON.stringify({ ...obj, bin: data.byteLength }) + "\n");
    const out = new Uint8Array(head.byteLength + data.byteLength);
    out.set(head);
    out.set(data, head.byteLength);
    return out;
  }

  // send resolves once the message is written (or the line is closed).
  send(obj) {
    return this.enqueue(this.urgent, this.frame(obj));
  }

  // sendBulk sends obj followed by the bytes in data, after any pending send.
  sendBulk(obj, data) {
    return this.enqueue(this.bulk, this.frame(obj, data));
  }

  enqueue(queue, bytes) {
    if (this.closed) return Promise.resolve();
    return new Promise((done) => {
      queue.push({ bytes, done });
      this.pump();
    });
  }

  async pump() {
    if (this.writing) return;
    this.writing = true;
    for (let item; !this.closed && (item = this.urgent.shift() ?? this.bulk.shift()); ) {
      try {
        await this.conn.write(item.bytes);
      } catch {
        this.close();
      }
      item.done();
    }
    this.writing = false;
  }

  // read pumps incoming messages to onMessage until the stream ends,
  // fails, or close() is called. It resolves once the line is closed.
  // Binary payloads are copied once, straight into a buffer of their
  // final size, however many reads they arrive in.
  async read(onMessage) {
    const dec = new TextDecoder();
    let tail = new Uint8Array(0); // the start of a JSON line still arriving
    let waiting = null; // {msg, got}: a message whose bytes are still arriving
    const dispatch = (msg) => {
      try {
        onMessage(msg);
      } catch (err) {
        console.error("shitchat: handler error", err);
      }
    };
    try {
      for (let chunk; !this.closed && (chunk = await this.conn.read()) !== null; ) {
        this.lastRx = Date.now();
        if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
        let pos = 0;
        while (!this.closed && pos < chunk.byteLength) {
          if (waiting) {
            const { msg } = waiting;
            const n = Math.min(msg.bin - waiting.got, chunk.byteLength - pos);
            msg.data.set(chunk.subarray(pos, pos + n), waiting.got);
            waiting.got += n;
            pos += n;
            if (waiting.got < msg.bin) break;
            waiting = null;
            dispatch(msg);
            continue;
          }
          const nl = chunk.indexOf(10, pos);
          if (nl < 0) {
            tail = concat(tail, chunk.slice(pos)); // a copy: chunk isn't ours to keep
            break;
          }
          const raw = dec.decode(concat(tail, chunk.subarray(pos, nl)));
          tail = new Uint8Array(0);
          pos = nl + 1;
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch {
            continue;
          }
          if (!msg || typeof msg !== "object" || typeof msg.t !== "string") continue;
          delete msg.data;
          if (msg.bin === undefined) {
            dispatch(msg);
            continue;
          }
          if (!Number.isInteger(msg.bin) || msg.bin < 0 || msg.bin > MAX_BIN) throw new Error("bad frame");
          msg.data = new Uint8Array(msg.bin);
          if (msg.bin) waiting = { msg, got: 0 };
          else dispatch(msg);
        }
        if (tail.byteLength > MAX_LINE) break; // garbage or abuse: hang up
      }
    } catch {
      // read error (or garbage): the connection is gone
    }
    this.close();
  }

  // sendLast sends a last word, then hangs up (within a second at most).
  async sendLast(obj) {
    await Promise.race([this.send(obj), sleep(1000)]);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const item of [...this.urgent.splice(0), ...this.bulk.splice(0)]) item.done();
    try {
      this.conn.close();
    } catch {}
  }
}

// since: the first message id this participant may see.
const seat = ({ id, name, token, delivered, seen, since = 1 }) => ({ id, name, token, delivered, seen, since });

// Hub is the host-side relay. It owns the roster and the message
// backlog, which only live in the host's tab (and, to survive a reload,
// in that tab's sessionStorage: see snapshot).
export class Hub {
  // snapshot: what snapshot() returned before a reload, to pick the
  // session back up with the same key, backlog and seats.
  // onChange: called whenever there's something new to snapshot.
  // secret: from makeSecret, if the session needs a password.
  // settings: see cleanSettings.
  constructor({ makeName, snapshot = null, secret = null, settings = null, onChange = () => {} }) {
    this.makeName = makeName;
    this.secret = secret;
    this.settings = cleanSettings(settings);
    this.authQueue = Promise.resolve();
    this.onChange = onChange;
    this.peers = new Map(); // connected: id -> {id, name, token, deliver, line, delivered, seen, typing}
    this.away = new Map(); // dropped out, may come back: id -> seat + left (when)
    this.kicked = new Set(); // ids of participants the host threw out
    this.messages = [];
    this.files = new Map(); // message id -> Blob, in memory only
    this.fileBytes = 0;
    this.nextPeerId = HOST_ID;
    this.nextMsgId = 1;
    this.keyJSON = "";
    if (snapshot) {
      this.keyJSON = snapshot.key;
      this.messages = snapshot.messages;
      this.nextPeerId = snapshot.nextPeerId;
      this.nextMsgId = snapshot.nextMsgId;
      this.secret = snapshot.secret ?? null;
      this.settings = cleanSettings(snapshot.settings);
      this.kicked = new Set(snapshot.kicked ?? []);
      const left = Date.now();
      for (const p of snapshot.peers) this.away.set(p.id, { ...seat(p), left });
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
      secret: this.secret,
      settings: this.settings,
      kicked: [...this.kicked],
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
      away: () => this.pause(),
      // The host's own files don't need to travel: hand them over as is.
      putFile: async (cid, file, onProgress) => {
        if (file.size > this.settings.maxFile) throw refused("too-big");
        if (this.ended || this.peers.get(p.id) !== p) throw new Error("interrupted");
        onProgress?.(file.size);
        return JSON.parse(JSON.stringify(this.addFile(p, cid, cleanFile(file), file)));
      },
      getFile: async (id) => {
        const blob = id >= p.since ? this.files.get(id) : null;
        if (!blob) throw gone();
        return blob;
      },
    };
  }

  accept(conn) {
    if (this.ended) {
      conn.close();
      return;
    }
    const line = new Line(conn);
    let p = null;
    let checking = false; // a hello is being checked
    let tries = 0; // wrong passwords on this connection
    let timer = 0;
    const deadline = (ms, denied) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (p) return;
        if (denied) line.sendLast({ t: "denied" });
        else line.close();
      }, ms);
    };
    deadline(HELLO_TIMEOUT_MS, false);
    const onHello = async (m) => {
      const why = this.door(m.resume);
      if (why) return line.sendLast({ t: why });
      const ok = await this.authorized(m);
      if (line.closed || this.ended) return line.close();
      if (ok) {
        clearTimeout(timer);
        p = this.hello(line, m);
        return;
      }
      if (typeof m.password === "string" && ++tries >= MAX_PASSWORD_TRIES) {
        clearTimeout(timer);
        return line.sendLast({ t: "denied" });
      }
      line.send({ t: "auth", wrong: typeof m.password === "string" });
      deadline(AUTH_TIMEOUT_MS, true);
    };
    line
      .read((m) => {
        if (p) {
          if (p.line === line) this.handle(p, m);
        } else if (m.t === "ping") {
          line.send({ t: "ping" }); // waiting for a password: keep the guest's heartbeat happy
        } else if (m.t === "hello" && !checking) {
          checking = true;
          onHello(m).finally(() => (checking = false));
        } else if (m.t !== "hello") {
          line.close();
        }
      })
      .then(() => {
        clearTimeout(timer);
        if (p) this.lost(p, line);
      });
  }

  // seatFor returns the seat a resume {id, token} points to, if valid.
  seatFor(r) {
    if (!r || typeof r !== "object" || !Number.isInteger(r.id) || typeof r.token !== "string") return null;
    const s = this.peers.get(r.id) ?? this.away.get(r.id);
    return s?.token && s.token === r.token ? s : null;
  }

  // door tells why a hello can't have a seat ("kicked", "locked",
  // "full"), or null if it can. Taking a seat back always works, unless
  // the host threw that seat out.
  door(resume) {
    if (Number.isInteger(resume?.id) && this.kicked.has(resume.id)) return "kicked";
    if (this.seatFor(resume)) return null;
    if (this.settings.locked) return "locked";
    const max = this.settings.maxPeople;
    if (max && this.peers.size + this.away.size >= max) return "full";
    return null;
  }

  // authorized tells whether a hello may get a seat: no password needed,
  // a valid seat to take back, or the right password. Checks run one at
  // a time and each wrong one costs WRONG_PASSWORD_DELAY_MS, so guessing
  // is slow even over many connections at once.
  authorized(m) {
    if (!this.secret || this.seatFor(m.resume)) return Promise.resolve(true);
    if (typeof m.password !== "string") return Promise.resolve(false);
    const password = m.password.slice(0, MAX_PASSWORD);
    const run = this.authQueue.then(async () => {
      if (this.ended) return false;
      const ok = await checkSecret(this.secret, password);
      if (!ok) await sleep(WRONG_PASSWORD_DELAY_MS);
      return ok;
    });
    this.authQueue = run.catch(() => {});
    return run.catch(() => false);
  }

  hello(line, m) {
    if (this.ended) {
      line.close();
      return null;
    }
    const deliver = (x) => line.send(x);
    const s = this.seatFor(m.resume);
    if (s?.line) {
      // Same guest on a new connection before we noticed the old one
      // died (quick reload), or the same seat open in two tabs: the
      // newest connection wins, the old one is told to stand down.
      s.line.sendLast({ t: "replaced" });
      s.line = line;
      s.deliver = deliver;
      deliver(this.welcome(s));
      return s;
    }
    if (s) {
      this.away.delete(s.id);
      return this.attach(deliver, line, s);
    }
    // Checked again: things may have changed during the password check.
    const why = this.door(m.resume);
    if (why) {
      line.sendLast({ t: why });
      return null;
    }
    return this.attach(deliver, line, null);
  }

  // attach seats a participant: a new one, or one coming back.
  attach(deliver, line, back) {
    const p = back
      ? { ...seat(back), deliver, line, typing: false }
      : {
          id: this.nextPeerId++,
          name: this.uniqueName(),
          token: line ? randomToken() : null,
          deliver,
          line,
          delivered: 0,
          seen: 0,
          since: this.settings.history === "all" ? 1 : this.nextMsgId,
          typing: false,
        };
    this.peers.set(p.id, p);
    p.deliver(this.welcome(p));
    this.announce(back ? "back" : "join", p, p.id);
    return p;
  }

  welcome(p) {
    return {
      t: "welcome",
      proto: PROTO,
      you: { id: p.id, name: p.name, token: p.token },
      hostId: HOST_ID,
      password: !!this.secret,
      peers: this.roster(),
      messages: this.messages.filter((m) => m.id >= p.since),
      settings: this.settings,
    };
  }

  // may tells whether p is allowed to send ("chat" or "files").
  may(p, what) {
    return allowed(this.settings, p.id, what);
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
        if (typeof m.text !== "string" || !this.may(p, "chat")) return;
        const text = m.text.slice(0, MAX_TEXT);
        if (!text.trim()) return;
        this.post(p, { text, cid: m.cid });
        break;
      }
      case "fput": {
        if (!p.line || typeof m.cid !== "string") return;
        p.upload = null;
        if (!this.may(p, "files")) {
          p.deliver({ t: "ferr", cid: m.cid.slice(0, 64), reason: "not-allowed" });
          return;
        }
        if (!Number.isInteger(m.size) || m.size < 0 || m.size > this.settings.maxFile) {
          p.deliver({ t: "ferr", cid: m.cid.slice(0, 64), reason: "too-big" });
          return;
        }
        p.upload = { cid: m.cid, meta: cleanFile(m), parts: [], got: 0 };
        if (m.size === 0) this.uploaded(p);
        break;
      }
      case "fchunk": {
        const u = p.upload;
        if (!u || m.cid !== u.cid || !(m.data instanceof Uint8Array)) return;
        if (u.got + m.data.byteLength > u.meta.size) {
          p.upload = null;
          return;
        }
        u.parts.push(m.data);
        u.got += m.data.byteLength;
        if (u.got === u.meta.size) this.uploaded(p);
        break;
      }
      case "fget":
        // Posted before p joined, with the history hidden: as if gone.
        if (Number.isInteger(m.id) && m.id < p.since) p.deliver({ t: "fgone", id: m.id });
        else this.stream(p, m.id);
        break;
      case "typing": {
        const on = !!m.on && this.settings.typing && this.may(p, "chat");
        if (on === p.typing) return;
        p.typing = on;
        this.broadcast({ t: "typing", from: p.id, on }, p.id);
        break;
      }
      case "receipt": {
        if (!this.settings.receipts) return;
        const max = this.nextMsgId - 1;
        const seen = Math.max(p.seen, clampInt(m.seen, 0, max));
        const delivered = Math.max(p.delivered, clampInt(m.delivered, 0, max), seen);
        if (seen === p.seen && delivered === p.delivered) return;
        p.seen = seen;
        p.delivered = delivered;
        // No onChange: not worth a snapshot. After a reload, guests send
        // their receipts again anyway.
        this.broadcast({ t: "receipt", from: p.id, delivered, seen }, p.id);
        break;
      }
      case "away":
        if (p.line) this.lost(p, p.line);
        break;
      case "set":
        if (p.id === HOST_ID && m.settings && typeof m.settings === "object") this.setSettings(m.settings);
        break;
      case "kick":
        if (p.id === HOST_ID) this.kick(m.id);
        break;
      case "bye":
        this.drop(p);
        break;
    }
  }

  // setSettings applies the host's changes and tells everyone.
  setSettings(changes) {
    const old = this.settings;
    const next = cleanSettings({ ...old, ...changes });
    if (Object.keys(next).every((k) => next[k] === old[k])) return;
    this.settings = next;
    // Whoever may no longer be typing stops.
    for (const q of this.peers.values()) {
      if (q.typing && (!next.typing || !this.may(q, "chat"))) {
        q.typing = false;
        this.broadcast({ t: "typing", from: q.id, on: false }, q.id);
      }
    }
    this.broadcast({ t: "settings", settings: next });
    // Receipts back on: everyone needs to know where the others are.
    if (next.receipts !== old.receipts) this.broadcast({ t: "roster", peers: this.roster() });
    this.onChange();
  }

  // post adds a message from p to the backlog and sends it to everyone.
  post(p, { text = "", cid, file }) {
    const msg = {
      t: "msg",
      id: this.nextMsgId++,
      from: p.id,
      name: p.name,
      text,
      ts: Date.now(),
    };
    if (typeof cid === "string") msg.cid = cid.slice(0, 64);
    if (file) msg.file = file;
    this.messages.push(msg);
    if (this.messages.length > BACKLOG) this.forgetFile(this.messages.shift().id);
    p.typing = false;
    this.broadcast(msg);
    this.onChange();
    return msg;
  }

  uploaded(p) {
    const u = p.upload;
    p.upload = null;
    this.addFile(p, u.cid, u.meta, new Blob(u.parts, { type: u.meta.type }));
  }

  addFile(p, cid, meta, blob) {
    while (this.files.size && this.fileBytes + blob.size > MAX_STORE) {
      this.forgetFile(this.files.keys().next().value);
    }
    const msg = this.post(p, { cid, file: { name: meta.name, type: meta.type, size: blob.size } });
    this.files.set(msg.id, blob);
    this.fileBytes += blob.size;
    return msg;
  }

  forgetFile(id) {
    const blob = this.files.get(id);
    if (!blob) return;
    this.files.delete(id);
    this.fileBytes -= blob.size;
  }

  // stream sends a file to a guest, piece by piece, each one waiting for
  // the previous one to be out: memory stays flat whatever the size.
  async stream(p, id) {
    const line = p.line;
    if (!line) return;
    const blob = this.files.get(id);
    if (!blob) return line.send({ t: "fgone", id: Number.isInteger(id) ? id : 0 });
    if ((line.streams ?? 0) >= MAX_STREAMS) return;
    line.streams = (line.streams ?? 0) + 1;
    try {
      for (let off = 0; off < blob.size; off += CHUNK) {
        if (line.closed || p.line !== line || this.ended) return;
        const data = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
        await line.sendBulk({ t: "fdata", id, off }, data);
      }
    } finally {
      line.streams--;
    }
  }

  // lost: the guest's connection is gone, but they may come back
  // (reload, flaky network): keep their seat.
  lost(p, line) {
    if (p.line !== line || this.peers.get(p.id) !== p) return;
    this.peers.delete(p.id);
    line.close();
    if (this.ended) return;
    this.away.set(p.id, { ...seat(p), left: Date.now() });
    this.announce("lost", p);
  }

  // kick throws a participant out, connected or not, for good.
  kick(id) {
    if (!Number.isInteger(id) || id === HOST_ID) return;
    const p = this.peers.get(id) ?? this.away.get(id);
    if (!p) return;
    this.kicked.add(id);
    this.away.delete(id);
    if (this.peers.get(id) === p) {
      this.peers.delete(id);
      p.line?.sendLast({ t: "kicked" });
    }
    this.announce("kicked", p);
  }

  // drop: the guest left for good.
  drop(p) {
    if (this.peers.get(p.id) !== p) return;
    this.peers.delete(p.id);
    p.line?.close();
    if (this.ended) return;
    this.announce("leave", p);
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
      this.end("expired");
      return;
    }
    // Guests give up after GRACE_MS: free their seats.
    for (const [id, s] of this.away) {
      if (id !== HOST_ID && now - s.left > GRACE_MS) this.away.delete(id);
    }
    for (const p of [...this.peers.values()]) {
      if (!p.line) continue;
      if (now - p.line.lastRx > DEAD_AFTER_MS) this.lost(p, p.line);
      else p.line.send({ t: "ping" });
    }
  }

  // announce tells everyone (but exceptId) who came or went.
  announce(kind, p, exceptId) {
    this.broadcast({ t: "roster", peers: this.roster(), event: { kind, id: p.id, name: p.name } }, exceptId);
    this.onChange();
  }

  broadcast(m, exceptId) {
    for (const p of this.peers.values()) {
      if (p.id !== exceptId) p.deliver(m);
    }
  }

  roster() {
    const r = this.settings.receipts;
    return [...this.peers.values()].map(({ id, name, delivered, seen }) => ({
      id,
      name,
      delivered: r ? delivered : 0,
      seen: r ? seen : 0,
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
  // The host's own UI is told right away, with reason ("destroyed" when
  // the host closed it, "expired" when its page slept too long).
  async end(reason = "destroyed") {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.local?.deliver({ t: "closed", reason });
    const remotes = [...this.peers.values()].filter((p) => p.line);
    await Promise.race([
      Promise.all(remotes.map((p) => p.line.send({ t: "end" }))),
      sleep(1500),
    ]);
    for (const p of remotes) p.line.close();
    this.peers.clear();
    this.away.clear();
    this.messages = [];
    this.files.clear();
    this.fileBytes = 0;
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
    this.password = null; // the last one we sent, for the hello on reconnections
    this.graceMs = graceMs;
    this.onEvent = onEvent;
    this.line = null;
    this.done = false;
    this.uploads = new Map(); // cid -> {resolve, reject}
    this.downloads = new Map(); // id -> {parts, got, size, type, onProgress, resolve, reject}
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
    line.send(this.hello());
    this.run(line);
  }

  hello() {
    const m = { t: "hello", proto: PROTO, resume: this.resume };
    if (this.password !== null) m.password = this.password;
    return m;
  }

  // login answers an "auth" event with a password.
  login(password) {
    this.password = password;
    this.line?.send(this.hello());
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
          case "denied":
          case "full":
          case "locked":
          case "kicked":
            outcome = m.t;
            return line.close();
          case "away":
            return line.close(); // the host is reloading (or leaving)
          case "welcome":
            this.resume = { id: m.you.id, token: m.you.token };
            break;
          case "msg":
            if (m.cid && m.from === this.resume?.id) this.settle(this.uploads, m.cid, null, m);
            break;
          case "ferr":
            return this.settle(this.uploads, m.cid, refused(m.reason));
          case "fgone":
            return this.settle(this.downloads, m.id, gone());
          case "fdata":
            return this.onData(m);
          case "closed":
          case "reconnecting":
            return; // only this session makes these up, never the wire
        }
        this.onEvent(m);
      })
      .then(() => {
        clearInterval(timer);
        for (const map of [this.uploads, this.downloads]) {
          for (const key of [...map.keys()]) this.settle(map, key, new Error("interrupted"));
        }
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

  settle(map, key, err, value) {
    const op = map.get(key);
    if (!op) return;
    map.delete(key);
    if (err) op.reject(err);
    else op.resolve(value);
  }

  onData(m) {
    const d = this.downloads.get(m.id);
    if (!d || !(m.data instanceof Uint8Array) || m.off !== d.got) return;
    d.parts.push(m.data);
    d.got += m.data.byteLength;
    d.onProgress?.(d.got);
    if (d.got >= d.size) this.settle(this.downloads, m.id, null, new Blob(d.parts, { type: d.type }));
  }

  // putFile sends a file (a Blob/File) and resolves once the hub has
  // posted it (with this cid). onProgress gets the bytes sent so far.
  // It rejects with .refused if the hub said no, or if the connection
  // dropped meanwhile ("interrupted": try again after the next welcome).
  async putFile(cid, file, onProgress) {
    const line = this.line;
    if (!line || this.done) throw new Error("interrupted");
    if (file.size > MAX_FILE) throw refused("too-big");
    const posted = new Promise((resolve, reject) => this.uploads.set(cid, { resolve, reject }));
    posted.catch(() => {}); // awaited below, after the sending loop
    line.send({ t: "fput", cid, name: file.name, type: file.type, size: file.size });
    for (let off = 0; off < file.size; off += CHUNK) {
      if (line.closed || !this.uploads.has(cid)) break;
      const data = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      await line.sendBulk({ t: "fchunk", cid }, data);
      onProgress?.(off + data.byteLength);
    }
    return posted;
  }

  // getFile fetches the contents of the file posted in message id.
  // Rejects with .gone if the hub doesn't have it, or "interrupted".
  getFile(id, { size, type }, onProgress) {
    if (!size) return Promise.resolve(new Blob([], { type }));
    const line = this.line;
    if (!line || this.done) return Promise.reject(new Error("interrupted"));
    this.settle(this.downloads, id, new Error("interrupted"));
    const p = new Promise((resolve, reject) =>
      this.downloads.set(id, { parts: [], got: 0, size, type, onProgress, resolve, reject }),
    );
    line.send({ t: "fget", id });
    return p;
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
    await line?.sendLast({ t: "bye" });
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
