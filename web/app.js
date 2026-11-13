// ShitChat UI. Plain JavaScript, no build step.
//
// The tailcat WebAssembly module (built from github.com/tailscale/tailcat's
// web/ package) exposes two globals: tailcatListen and tailcatDial.
// core.js implements the chat protocol on top of them.

import {
  Hub, join, makeSecret, cleanSettings, allowed,
  HOST_ID, MAX_TEXT, MAX_FILE, MAX_PEOPLE, PROTO, GRACE_MS, DEFAULT_SETTINGS,
} from "./core.js";
import { randomName } from "./names.js";

const params = new URLSearchParams(location.search);
const verbose = params.has("verbose");
// The public tailcat DERP map; tailcat.dev serves it with CORS headers.
const derpMapURL = params.get("derpmap")
  ? new URL(params.get("derpmap"), location.href).toString()
  : "https://tailcat.dev/derpmap.json";

const $ = (id) => document.getElementById(id);
const baseURL = location.origin + location.pathname;

// The tailcat address travels in the URL fragment (#tc…), which browsers
// never send to the web server. takeInviteFromHash reads it, then wipes
// it from the address bar and history.
function takeInviteFromHash() {
  let h = "";
  try {
    h = decodeURIComponent(location.hash.slice(1)).trim();
  } catch {} // a malformed link: as if there were none
  if (!h.startsWith("tc")) return null;
  history.replaceState(null, "", baseURL + location.search);
  return h;
}
let inviteAddr = takeInviteFromHash();
const linkTo = (addr) => `${baseURL}#${addr}`;

const S = {
  session: null, // {send(msg), close(), away(), putFile(), getFile()}
  hub: null, // host only
  isHost: false,
  resumed: false, // picked up after a reload
  closed: false,
  authPending: false, // guest: the host asked for the password
  me: null, // {id, name, token}
  settings: DEFAULT_SETTINGS,
  addr: "",
  peers: new Map(), // id -> {id, name, delivered, seen}
  typing: new Set(), // peer ids currently typing
  lastMsgId: 0,
  sentReceipt: { delivered: 0, seen: 0 },
  pending: new Map(), // cid -> <li> of a message not yet echoed by the hub
  mine: new Map(), // msg id -> <li> of my messages, for read receipts
  unread: 0,
  blobs: new Map(), // msg id -> file entry (see fileEntry), in memory only
  gone: new Set(), // msg ids of files the host no longer has
  upQueue: [], // cids of my files waiting to be sent, in order
  uploading: false,
  downQueue: new Set(), // msg ids of files to fetch
  downloading: false,
  saveWhenDone: new Set(), // msg ids of files to save once fetched
  replaying: false, // onWelcome is rendering the backlog
  hasPassword: false, // the session needs a password on top of the link
  starting: false, // host: creating or restoring the session (not live yet)
};

// ---------- Small helpers ----------
function el(tag, cls, text) {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (text !== undefined) x.textContent = text;
  return x;
}


function setScreen(name) {
  document.body.dataset.screen = name;
}

// setStatus shows a note or an error under the primary button ("" hides it).
function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

function hue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function avatar(name) {
  const span = el("span", "avatar", name.slice(0, 1));
  span.style.setProperty("--hue", hue(name));
  return span;
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function listNames(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names.at(-1);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1 << 20)).toFixed(n < 10 << 20 ? 1 : 0)} MB`;
}

const newCid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const isActive = () => document.visibilityState === "visible" && document.hasFocus();

// ---------- Surviving a reload ----------
//
// The session is kept in sessionStorage, which belongs to this tab only
// and dies with it: a reload (or the browser discarding a background
// tab) picks the session back up, closing the tab ends it. The host
// keeps the tailcat key, the backlog and the seats; a guest keeps the
// address and their seat. A copy older than GRACE_MS is useless (the
// guests gave up) and is thrown away, so reopening a closed tab later
// doesn't bring a dead session back.

const STORE = "shitchat";
const ALIVE = "shitchat:alive";

function forget() {
  try {
    sessionStorage.removeItem(STORE);
    sessionStorage.removeItem(ALIVE);
  } catch {}
}

function touch() {
  try {
    sessionStorage.setItem(ALIVE, String(Date.now()));
  } catch {}
}

function save(state) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(state));
    touch();
  } catch (err) {
    console.warn("shitchat: couldn't save the session", err);
  }
}

function loadSaved() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE));
    const alive = Number(sessionStorage.getItem(ALIVE));
    if (saved && Date.now() - alive < GRACE_MS) return saved;
  } catch {}
  forget();
  return null;
}

setInterval(() => S.session && !S.closed && touch(), 5000);

let saveTimer = 0;
function saveHost() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (S.hub && S.addr && !S.closed) save({ role: "host", addr: S.addr, hub: S.hub.snapshot() });
}
function saveHostSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveHost, 300);
}

// "Duplicate tab" copies sessionStorage. Ask the other tabs whether the
// session we're about to resume is still running in one of them.
const seatKey = (role, addr, token) => `${role}:${addr}:${token ?? ""}`;
const mySeat = () => S.session && !S.closed && seatKey(S.isHost ? "host" : "guest", S.addr, S.me?.token);
const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("shitchat") : null;
if (channel) {
  channel.onmessage = (e) => {
    if (e.data?.t === "who" && e.data.seat === mySeat()) channel.postMessage({ t: "mine", seat: e.data.seat });
  };
}

function inUseElsewhere(seat) {
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ask = new BroadcastChannel("shitchat");
    const done = (v) => {
      ask.close();
      resolve(v);
    };
    ask.onmessage = (e) => e.data?.t === "mine" && e.data.seat === seat && done(true);
    ask.postMessage({ t: "who", seat });
    setTimeout(() => done(false), 400);
  });
}

// resumable returns the session this tab can pick back up, if any.
async function resumable() {
  const saved = loadSaved();
  if (!saved) return null;
  // Opening another invite link in this tab replaces the session.
  if (inviteAddr && inviteAddr !== saved.addr) {
    forget();
    return null;
  }
  if (await inUseElsewhere(seatKey(saved.role, saved.addr, saved.resume?.token))) {
    forget();
    return null;
  }
  return saved;
}

// ---------- WebAssembly boot ----------

// GitHub Pages can't negotiate Content-Encoding and doesn't compress wasm,
// so the build publishes only main.wasm.gz (~6.5 MB instead of ~27 MB) and
// we decompress it here. Same approach as tailcat's own web demo.
async function fetchWasm() {
  let resp = await fetch("main.wasm.gz");
  let gzipped = resp.ok;
  if (!gzipped) {
    resp = await fetch("main.wasm");
    if (!resp.ok) throw new Error(`main.wasm: HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get("Content-Length")) || 0;
  let loaded = 0;
  let shown = -1;
  let body = resp.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        if (total) {
          const pct = Math.floor((100 * loaded) / total);
          if (pct === shown) return ctl.enqueue(chunk);
          shown = pct;
          primaryBtn.style.setProperty("--p", `${pct}%`);
          primaryBtn.textContent = `Loading… ${pct}%`;
        }
        ctl.enqueue(chunk);
      },
    }),
  );
  if (gzipped) body = body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(body, { headers: { "Content-Type": "application/wasm" } });
}

async function bootWasm() {
  const ready = new Promise((resolve) => {
    globalThis.onTailcatReady = resolve;
  });
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetchWasm(), go.importObject);
  go.run(instance);
  await ready;
}

// ---------- Starting / joining ----------

const primaryBtn = $("primary-btn");
const passwordInput = $("password");

const advanced = $("advanced");

function setFormDisabled(off) {
  primaryBtn.disabled = off;
  primaryBtn.classList.toggle("loading", off);
  primaryBtn.style.setProperty("--p", "0%");
  passwordInput.disabled = off;
  for (const x of advanced.querySelectorAll("input, select")) x.disabled = off;
}

// busy shows what's going on in the primary button, plus an optional note.
function busy(label, note = "") {
  setFormDisabled(true);
  primaryBtn.textContent = label;
  setStatus(note);
}

function failed(text) {
  setFormDisabled(false);
  setStatus(text, true);
}

// ---------- Session settings ----------
// The same fields show up in the home screen's advanced options (when
// creating a session) and in the settings sheet (during it: editable by
// the host, read-only for guests). See cleanSettings in core.js.

const MB = 1 << 20;
const WHO = [["all", "Everyone"], ["host", "Only the host"]];
const ON_OFF = [[true, "On"], [false, "Off"]];
const FIELDS = [
  { key: "locked", label: "New people", live: true, options: [[false, "Can join"], [true, "Locked out"]] },
  { key: "maxPeople", label: "Max people", number: { min: 2, max: MAX_PEOPLE, empty: 0, placeholder: "No limit" } },
  { key: "chat", label: "Who can write", options: WHO },
  { key: "files", label: "Who can send files", options: WHO },
  { key: "maxFile", label: "Max file size", number: { min: 1, max: MAX_FILE / MB, unit: MB, suffix: "MB" } },
  { key: "autoload", label: "Received files", options: [[false, "On demand"], [true, "Automatic"]] },
  { key: "history", label: "Newcomers see", options: [["all", "Everything"], ["none", "Only new ones"]] },
  { key: "receipts", label: "Read receipts", options: ON_OFF },
  { key: "typing", label: '"Is typing…"', options: ON_OFF },
];

// buildOpts fills a .opts grid with the fields; onEdit(key, value) is
// called when one of them changes.
function buildOpts(box, prefix, { live = false, onEdit = null } = {}) {
  box.replaceChildren();
  for (const f of FIELDS) {
    if (f.live && !live) continue;
    const id = `${prefix}-${f.key}`;
    const label = el("label", "", f.label);
    label.htmlFor = id;
    let ctl;
    if (f.options) {
      ctl = el("select");
      for (const [v, text] of f.options) {
        const o = el("option", "", text);
        o.value = String(v);
        ctl.append(o);
      }
    } else {
      ctl = el("input");
      Object.assign(ctl, { type: "number", min: f.number.min, max: f.number.max, step: 1, inputMode: "numeric" });
      ctl.placeholder = f.number.placeholder ?? String(f.number.max);
    }
    ctl.id = id;
    ctl.dataset.key = f.key;
    if (onEdit) ctl.onchange = () => onEdit(f.key, readField(f, ctl));
    let cell = ctl;
    if (f.number?.suffix) {
      cell = el("div", "unit");
      cell.append(ctl, el("span", "", f.number.suffix));
    }
    box.append(label, cell);
  }
}

function readField(f, ctl) {
  if (f.options) return f.options.find(([v]) => String(v) === ctl.value)?.[0];
  const n = Number(ctl.value);
  if (!ctl.value || !Number.isFinite(n)) return f.number.empty ?? 0;
  return Math.round(n * (f.number.unit ?? 1));
}

function readOpts(box) {
  const s = {};
  for (const f of FIELDS) {
    const ctl = box.querySelector(`[data-key="${f.key}"]`);
    if (ctl) s[f.key] = readField(f, ctl);
  }
  return cleanSettings(s);
}

function fillOpts(box, s) {
  for (const f of FIELDS) {
    const ctl = box.querySelector(`[data-key="${f.key}"]`);
    if (!ctl) continue;
    if (f.options) ctl.value = String(s[f.key]);
    else ctl.value = s[f.key] === f.number.empty ? "" : String(s[f.key] / (f.number.unit ?? 1));
  }
}

// describe says what a setting is set to, in words.
function describe(key, s) {
  const f = FIELDS.find((x) => x.key === key);
  if (key === "maxPeople") return s.maxPeople ? String(s.maxPeople) : "no limit";
  if (key === "maxFile") return fmtSize(s.maxFile);
  return (f.options.find(([v]) => v === s[key])?.[1] ?? String(s[key])).toLowerCase();
}

const homeOpts = $("home-opts");
buildOpts(homeOpts, "opt");

// hostSession creates a session, or resumes the saved one after a reload.
async function hostSession(saved = null) {
  busy(saved ? "Restoring your session…" : "Creating the session…");
  S.starting = true;
  let hub = null;
  try {
    const password = saved ? "" : passwordInput.value;
    const secret = password ? await makeSecret(password) : null;
    const settings = saved ? null : readOpts(homeOpts);
    hub = new Hub({ makeName: randomName, snapshot: saved?.hub, secret, settings, onChange: saveHostSoon });
    const addr = await hub.listen(globalThis.tailcatListen, { derpMapURL, verbose });
    S.isHost = true;
    S.resumed = !!saved;
    S.hub = hub;
    S.addr = addr;
    saveHost();
    S.session = hub.openLocal(onEvent);
    passwordInput.value = "";
  } catch (err) {
    hub?.end();
    forget();
    inviteAddr = null;
    $("invite-note").hidden = true;
    primaryBtn.textContent = "Create a session";
    passwordInput.hidden = false;
    advanced.hidden = false;
    failed(`Couldn't ${saved ? "restore" : "create"} the session: ${err.message}`);
  } finally {
    S.starting = false;
  }
}

// joinSession joins inviteAddr, or takes our seat back after a reload.
async function joinSession(resume = null) {
  busy(
    resume ? "Reconnecting…" : "Connecting…",
    resume ? "" : "If the session no longer exists, this fails after a minute.",
  );
  try {
    S.resumed = !!resume;
    S.addr = inviteAddr;
    S.session = await join(
      globalThis.tailcatDial,
      { addr: inviteAddr, derpMapURL, verbose, resume },
      onEvent,
    );
  } catch (err) {
    primaryBtn.textContent = "Try again";
    failed(`Couldn't connect: the session was probably destroyed. (${err.message})`);
  }
}

$("start").onsubmit = (e) => {
  e.preventDefault();
  if (S.authPending) sendPassword();
  else if (inviteAddr) joinSession();
  else hostSession();
};

// askPassword: the host wants a password before letting us in.
function askPassword(wrong) {
  S.authPending = true;
  setFormDisabled(false);
  passwordInput.hidden = false;
  advanced.hidden = true;
  passwordInput.required = true;
  passwordInput.placeholder = "Password";
  passwordInput.setAttribute("aria-label", "Password");
  passwordInput.autocomplete = "current-password";
  primaryBtn.textContent = "Join";
  setStatus(wrong ? "Wrong password, try again." : "This session is protected by a password.", wrong);
  setScreen("home");
  passwordInput.value = "";
  passwordInput.focus();
}

function sendPassword() {
  const password = passwordInput.value;
  if (!password || !S.session) return;
  S.authPending = false;
  passwordInput.value = "";
  busy("Checking the password…");
  S.session.login(password);
}

// ---------- Protocol events ----------

function onEvent(m) {
  if (S.closed) return;
  switch (m.t) {
    case "auth":
      return askPassword(m.wrong);
    case "welcome":
      return onWelcome(m);
    case "roster":
      return onRoster(m);
    case "settings":
      return onSettings(m);
    case "msg":
      return onMsg(m);
    case "typing":
      return onTyping(m);
    case "receipt":
      return onReceipt(m);
    case "reconnecting":
      return onReconnecting(m);
    case "closed":
      return onClosed(m.reason);
  }
}

function setPeers(list) {
  S.peers = new Map(list.map((p) => [p.id, { ...p }]));
  for (const id of S.typing) if (!S.peers.has(id)) S.typing.delete(id);
}

// onWelcome runs when we get our seat: first join, and again after each
// reconnection (the hub then sends the whole backlog again).
function onWelcome(m) {
  S.authPending = false;
  if (m.proto !== PROTO) console.warn("shitchat: protocol mismatch", m.proto, PROTO);
  const first = !S.me;
  S.me = m.you;
  S.hasPassword = !!m.password;
  S.settings = cleanSettings(m.settings);
  applySettings();
  if (!S.isHost) save({ role: "guest", addr: S.addr, resume: { id: m.you.id, token: m.you.token } });
  setPeers(m.peers);
  S.typing.clear();
  // Messages typed while disconnected (or lost in the cut) that the hub
  // never got: send them again below.
  const echoed = new Map(m.messages.filter((x) => x.cid && x.from === m.you.id).map((x) => [x.cid, x]));
  const unsent = [];
  for (const [cid, li] of S.pending) {
    const done = echoed.get(cid);
    if (!done) unsent.push([cid, li]);
    else if (li._local && !S.blobs.has(done.id)) S.blobs.set(done.id, li._local);
  }
  S.pending.clear();
  S.mine.clear();
  S.lastMsgId = 0;
  S.sentReceipt = { delivered: 0, seen: 0 };
  $("messages").replaceChildren();
  // Ticks and scrolling are done once, below, not per message.
  S.replaying = true;
  try {
    for (const msg of m.messages) renderMsg(msg);
  } finally {
    S.replaying = false;
  }
  if (!first || S.resumed) {
    system(S.isHost ? `Session restored. You are still ${S.me.name}.` : `Reconnected. You are ${S.me.name}.`);
  } else {
    system(
      S.isHost
        ? `Session created. You are ${S.me.name}. Share the link to invite people.`
        : `You joined the session as ${S.me.name}.`,
    );
    for (const note of settingsNotes()) system(note);
  }
  S.upQueue = S.upQueue.filter((cid) => unsent.some(([c]) => c === cid));
  for (const [cid, li] of unsent) {
    li.classList.remove("cont");
    S.pending.set(cid, li);
    appendMsg(li, S.me.id, true);
    if (li._file) {
      if (!S.upQueue.includes(cid)) S.upQueue.push(cid);
    } else {
      S.session?.send({ t: "msg", text: li._text, cid });
    }
  }
  pumpUploads();
  pumpDownloads();
  setOffline(false);
  $("invite-link").value = linkTo(S.addr);
  $("leave-btn").textContent = S.isHost ? "Destroy" : "Leave";
  setScreen("chat");
  renderRoster();
  renderTyping();
  refreshTicks();
  sendReceipts();
  scrollToBottom(true);
  if (first && S.isHost && !S.resumed) openInvite();
  else if (first) $("input").focus();
}

const amHost = () => S.me?.id === HOST_ID;
const may = (what) => !!S.me && allowed(S.settings, S.me.id, what);

// applySettings adapts the page to what the host allows.
function applySettings() {
  const locked = S.settings.locked;
  const host = amHost();
  fillOpts(liveOpts, S.settings);
  for (const c of liveOpts.querySelectorAll("input, select")) c.disabled = !host;
  $("settings-note").textContent = host
    ? "Changes apply right away, and everyone is told."
    : "Set by the host. You'll be told when they change something.";
  // The host sees the state on the lock button itself.
  $("locked-pill").hidden = !locked || host;
  const lock = $("lock-btn");
  lock.hidden = !host;
  lock.textContent = locked ? "🔒" : "🔓";
  lock.classList.toggle("on", locked);
  lock.title = locked ? "Locked: nobody new can join. Tap to unlock." : "Open: tap to lock the session.";
  lock.setAttribute("aria-label", locked ? "Unlock the session" : "Lock the session");
  const secret = S.hasPassword;
  $("invite-open").hidden = locked || secret;
  $("invite-locked").hidden = locked || !secret;
  $("invite-shut").hidden = !locked;
  const chat = may("chat");
  input.disabled = !chat;
  $("send-btn").disabled = !chat;
  input.placeholder = chat ? "Write a message…" : "Only the host can write";
  const files = may("files");
  $("attach-btn").hidden = !files;
  $("camera-btn").hidden = !files || !matchMedia("(pointer: coarse)").matches;
}

// settingsNotes describes the session's rules, for the first welcome.
function settingsNotes() {
  const s = S.settings;
  const host = amHost();
  const notes = [];
  if (s.maxPeople) notes.push(`This session is limited to ${s.maxPeople} people.`);
  if (s.chat === "host") notes.push(host ? "Only you can write in this session." : "Only the host can write in this session.");
  if (s.files === "host" && s.chat !== "host") {
    notes.push(host ? "Only you can send files." : "Only the host can send files.");
  }
  if (s.maxFile < MAX_FILE && (s.files === "all" || host)) notes.push(`Files are limited to ${fmtSize(s.maxFile)}.`);
  if (s.history === "none") notes.push("Newcomers don't see the messages sent before they joined.");
  if (!s.receipts) notes.push("Read receipts are off.");
  if (!s.typing) notes.push('"Is typing…" is off.');
  if (s.locked) notes.push("The session is locked: nobody new can join.");
  return notes;
}

function onReconnecting(m) {
  stopTyping(false);
  S.typing.clear();
  renderTyping();
  if (!S.me) return; // resuming after a reload: the home screen shows the status
  $("conn-sub").textContent =
    `The host is unreachable. What you write is sent when they're back (until ${fmtTime(m.until)}).`;
  setOffline(true);
}

// setOffline shows (or hides) that the host can't be reached right now.
function setOffline(on) {
  $("conn").hidden = !on;
  $("chat").classList.toggle("offline", on);
}

const ROSTER_VERBS = {
  join: "joined the session",
  back: "is back",
  lost: "lost the connection",
  leave: "left",
  kicked: "was removed by the host",
};

function onRoster(m) {
  setPeers(m.peers);
  if (m.event) system(`${m.event.name} ${(Object.hasOwn(ROSTER_VERBS, m.event.kind) ? ROSTER_VERBS[m.event.kind] : "left")}.`);
  renderRoster();
  renderTyping();
  refreshTicks();
}

function onSettings(m) {
  const old = S.settings;
  const s = cleanSettings(m.settings);
  S.settings = s;
  applySettings();
  const who = amHost() ? "You" : "The host";
  if (s.locked !== old.locked) {
    system(
      s.locked
        ? `${who} locked the session: nobody new can join.`
        : `${who} unlocked the session: anyone with the link can join.`,
    );
  }
  const changed = FIELDS.filter((f) => f.key !== "locked" && s[f.key] !== old[f.key]);
  if (changed.length) {
    const what = changed.map((f) => `${f.label} → ${describe(f.key, s)}`).join(", ");
    system(`${who} changed the settings: ${what}.`);
  }
  if (!s.typing) {
    S.typing.clear();
    renderTyping();
  }
  if (s.receipts && !old.receipts) sendReceipts();
  refreshTicks();
}

function onMsg(m) {
  S.typing.delete(m.from);
  renderMsg(m);
  if (m.from !== S.me.id && !isActive()) {
    S.unread++;
    updateTitle();
  }
  renderTyping();
  sendReceipts();
}

function onTyping(m) {
  if (m.on) S.typing.add(m.from);
  else S.typing.delete(m.from);
  renderTyping();
}

function onReceipt(m) {
  const p = S.peers.get(m.from);
  if (!p) return;
  p.delivered = m.delivered;
  p.seen = m.seen;
  refreshTicks();
}

const ENDINGS = {
  destroyed: ["Session destroyed", "You destroyed the session. The messages are gone and the link is dead."],
  ended: ["Session destroyed", "The host ended the session. The messages are gone and the link is dead."],
  left: ["You left", "You left the session. The messages are gone from this tab."],
  replaced: ["Opened elsewhere", "This session was picked up in another tab, so this one stepped aside."],
  denied: [
    "Access denied",
    "Too many wrong passwords, or it took too long to type one. Open the link again to retry.",
  ],
  kicked: ["Removed", "The host removed you from the session. The messages are gone from this tab."],
  locked: [
    "Session locked",
    "The host isn't letting anyone new in right now. Ask them to unlock it, then open the link again.",
  ],
  full: [
    "Session full",
    "This session has reached the number of people its host allowed. Ask them to make room, then open the link again.",
  ],
  expired: [
    "Session expired",
    "This page was asleep for too long and the guests gave up, so the session was destroyed. The link is dead.",
  ],
};

function onClosed(reason) {
  showEnded(
    ...((Object.hasOwn(ENDINGS, reason) && ENDINGS[reason]) || [
      "Session over",
      S.me
        ? "Lost contact with the host for too long: they probably closed their tab, so the session no longer exists."
        : "Couldn't get back to the session: the host probably closed their tab, so it no longer exists.",
    ]),
  );
}

function showEnded(title, text) {
  S.closed = true;
  S.session = null;
  S.hub = null;
  forget();
  setOffline(false);
  S.peers.clear();
  S.pending.clear();
  S.mine.clear();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  for (const e of S.blobs.values()) URL.revokeObjectURL(e.url);
  S.blobs.clear();
  S.gone.clear();
  S.upQueue = [];
  S.downQueue.clear();
  S.saveWhenDone.clear();
  $("messages").replaceChildren();
  $("ended-title").textContent = title;
  $("ended-text").textContent = text;
  document.title = "ShitChat";
  setScreen("ended");
}

// ---------- Rendering ----------

function nearBottom() {
  const el = $("messages");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom(force) {
  const el = $("messages");
  if (force || nearBottom()) el.scrollTop = el.scrollHeight;
}

function system(text) {
  const stick = nearBottom();
  $("messages").append(el("li", "system", text));
  scrollToBottom(stick);
}

function buildMsg({ mine, from, name, text, file }) {
  const li = el("li", `msg ${mine ? "mine" : "theirs"}`);
  li.dataset.from = from;
  li.style.setProperty("--hue", hue(name));
  const bubble = el("div", file ? "bubble has-file" : "bubble");
  if (file) li._meta = file;
  else li._text = text;
  // Kept on the <li>: refreshTicks touches them on every receipt.
  li._time = el("time");
  li._ticks = el("span", "ticks");
  li._receipt = el("div", "receipt");
  const meta = el("span", "meta");
  meta.append(li._time, li._ticks);
  bubble.append(file ? el("div", "att") : el("p", "text", text), meta);
  li.append(el("div", "author", name), bubble, li._receipt);
  return li;
}

function appendMsg(li, from, force) {
  const list = $("messages");
  const stick = force || (!S.replaying && nearBottom());
  const prev = list.lastElementChild;
  if (prev && prev.classList.contains("msg") && prev.dataset.from === String(from)) {
    li.classList.add("cont");
  }
  list.append(li);
  if (!S.replaying) scrollToBottom(stick);
}

function renderMsg(m) {
  const mine = m.from === S.me.id;
  let li = mine && m.cid ? S.pending.get(m.cid) : null;
  if (li) {
    S.pending.delete(m.cid);
    li.classList.remove("pending");
    if (li._local && !S.blobs.has(m.id)) S.blobs.set(m.id, li._local);
  } else {
    li = buildMsg({ mine, from: m.from, name: m.name, text: m.text, file: m.file });
    appendMsg(li, m.from, mine);
  }
  li.dataset.id = m.id;
  if (m.file) {
    li._meta = m.file;
    if (S.settings.autoload) wantFile(m.id);
    paintAtt(li);
  }
  li._time.textContent = fmtTime(m.ts);
  S.lastMsgId = Math.max(S.lastMsgId, m.id);
  if (mine) {
    S.mine.set(m.id, li);
    if (!S.replaying) refreshTicks();
  }
}

function statusFor(id, others) {
  if (!others.length) return { ticks: "✓", cls: "sent", label: "Sent · nobody else here" };
  const seenBy = others.filter((p) => p.seen >= id);
  if (seenBy.length === others.length) {
    return { ticks: "✓✓", cls: "seen", label: others.length === 1 ? "Seen" : "Seen by everyone" };
  }
  if (seenBy.length) {
    return { ticks: "✓✓", cls: "partial", label: `Seen by ${listNames(seenBy.map((p) => p.name))}` };
  }
  if (others.every((p) => p.delivered >= id)) return { ticks: "✓✓", cls: "delivered", label: "Delivered" };
  return { ticks: "✓", cls: "sent", label: "Sent" };
}

function refreshTicks() {
  if (!S.me) return;
  const others = [...S.peers.values()].filter((p) => p.id !== S.me.id);
  let lastId = 0;
  for (const id of S.mine.keys()) lastId = Math.max(lastId, id);
  for (const [id, li] of S.mine) {
    const st = S.settings.receipts ? statusFor(id, others) : { ticks: "✓", cls: "sent", label: "Sent" };
    const receipt = id === lastId && S.settings.receipts ? st.label : "";
    const key = `${st.cls} ${st.label} ${receipt}`;
    if (li._tickKey === key) continue;
    li._tickKey = key;
    li._ticks.textContent = st.ticks;
    li._ticks.className = `ticks ${st.cls}`;
    li._ticks.title = st.label;
    li._receipt.textContent = receipt;
  }
}

function renderRoster() {
  const ul = $("roster");
  ul.replaceChildren();
  for (const p of S.peers.values()) {
    const li = el("li", p.id === S.me.id ? "me" : "");
    li.append(avatar(p.name), p.name);
    const tags = [];
    if (p.id === S.me.id) tags.push("you");
    if (p.id === HOST_ID) tags.push("host");
    if (tags.length) li.append(el("span", "badge", `(${tags.join(", ")})`));
    if (amHost() && p.id !== S.me.id) {
      const x = el("button", "kick", "✕");
      x.type = "button";
      x.title = `Remove ${p.name}`;
      x.setAttribute("aria-label", `Remove ${p.name}`);
      x.onclick = () => {
        if (confirm(`Remove ${p.name} from the session? They can come back with the link unless you lock it.`)) {
          S.session?.send({ t: "kick", id: p.id });
        }
      };
      li.append(x);
    }
    ul.append(li);
  }
  const n = S.peers.size;
  $("online").textContent = `${n} ${n === 1 ? "person" : "people"}`;
}

function renderTyping() {
  const names = [...S.typing].map((id) => S.peers.get(id)?.name).filter(Boolean);
  let text = "";
  if (names.length === 1) text = `${names[0]} is typing`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing`;
  else if (names.length > 2) text = `${names.length} people are typing`;
  $("typing").textContent = text;
}

function updateTitle() {
  document.title = S.unread ? `(${S.unread}) ShitChat` : "ShitChat";
}

// ---------- Files ----------
//
// Files live in memory only, as blob: URLs. A received file only gets a
// type the page can render safely (images and videos from a short list);
// anything else is application/octet-stream, so it can only be saved,
// never opened in this page.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const kindOf = (type) => (IMAGE_TYPES.has(type) ? "image" : VIDEO_TYPES.has(type) ? "video" : "file");

function fileEntry(blob, meta) {
  const kind = kindOf(meta.type);
  const safe = new Blob([blob], { type: kind === "file" ? "application/octet-stream" : meta.type });
  return { blob: safe, url: URL.createObjectURL(safe), name: meta.name, type: meta.type, kind };
}

// The share sheet (Android: save to gallery, open in another app…).
const shareable = (e) => new File([e.blob], e.name, { type: e.type || "application/octet-stream" });
function canShare(e) {
  try {
    return !!navigator.canShare?.({ files: [shareable(e)] });
  } catch {
    return false;
  }
}
const share = (e) => navigator.share({ files: [shareable(e)] }).catch(() => {});

const findMsg = (id) => $("messages").querySelector(`li[data-id="${id}"]`);

function saveLink(e) {
  const a = el("a", "btn small", "Save");
  a.href = e.url;
  a.download = e.name;
  return a;
}

// attState tells where a file message's attachment stands.
function attState(li, id, entry) {
  if (li._failed) return "failed";
  if (li.classList.contains("pending")) return "sending";
  if (entry) return "ready";
  if (S.gone.has(id)) return "gone";
  return S.downQueue.has(id) ? "receiving" : "idle";
}

// paintAtt (re)draws a file message's attachment for its current state.
function paintAtt(li) {
  const box = li.querySelector(".att");
  if (!box) return;
  const meta = li._meta;
  const id = Number(li.dataset.id) || 0;
  const entry = (id && S.blobs.get(id)) || li._local || null;
  const state = attState(li, id, entry);
  const key = `${state} ${entry?.url ?? ""} ${entry?.kind ?? ""}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const stick = nearBottom();
  box.replaceChildren();

  const media = entry && entry.kind !== "file" && state !== "failed";
  box.parentElement.classList.toggle("media", !!media);
  if (media) {
    const broken = () => {
      entry.kind = "file"; // a format this browser can't show (HEIC…)
      paintAtt(li);
    };
    if (entry.kind === "image") {
      const btn = el("button", "photo");
      btn.type = "button";
      btn.setAttribute("aria-label", `View ${entry.name}`);
      const img = el("img");
      img.alt = entry.name;
      img.src = entry.url;
      img.onerror = broken;
      img.onload = () => scrollToBottom(stick);
      btn.append(img);
      btn.onclick = () => openViewer(entry);
      box.append(btn);
    } else {
      const v = el("video", "clip");
      v.controls = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.src = entry.url;
      v.onerror = broken;
      v.onloadedmetadata = () => scrollToBottom(stick);
      box.append(v);
    }
  }

  const bar = el("div", "filebar");
  const info = el("div", "fileinfo");
  if (!media) info.append(el("span", "fileicon", kindOf(meta.type) === "file" ? "📄" : "🖼️"));
  const label = el("div", "filelabel");
  const fname = el("span", "filename", meta.name);
  fname.title = meta.name;
  label.append(fname, el("span", "filesize", fmtSize(meta.size)));
  info.append(label);
  bar.append(info);
  const actions = el("div", "fileactions");
  if (state === "ready") {
    actions.append(saveLink(entry));
    if (!media && canShare(entry)) {
      const b = el("button", "btn small", "Share");
      b.type = "button";
      b.onclick = () => share(entry);
      actions.append(b);
    }
  } else if (state === "idle") {
    // Not fetched yet: a photo or video shows up in the chat once
    // loaded, any other file is saved right away.
    const showable = kindOf(meta.type) !== "file";
    const b = el("button", "btn small", showable ? "Load" : "Download");
    b.type = "button";
    b.title = showable ? `Show ${meta.name} in the chat` : `Download ${meta.name}`;
    b.onclick = () => {
      if (!showable) S.saveWhenDone.add(id);
      wantFile(id);
      paintAtt(li);
    };
    actions.append(b);
  }
  if (actions.childElementCount) bar.append(actions);
  box.append(bar);

  if (state === "sending" || state === "receiving") {
    const st = el("div", "att-status");
    const prog = el("progress");
    prog.max = 1;
    prog.value = 0;
    const verb = state === "sending" ? "Sending" : "Receiving";
    st.append(prog, el("span", "pct", `${verb}…`));
    st.dataset.verb = verb;
    box.append(st);
  } else if (state === "gone") {
    box.append(el("div", "att-status note-text", "No longer available (the host reloaded)."));
  } else if (state === "failed") {
    box.append(el("div", "att-status note-text", `Not sent: ${li._failed}.`));
  }
}

// setProgress runs for every piece of a file: it only touches the page
// when the percentage changes.
function setProgress(li, n) {
  const st = li?.querySelector(".att-status");
  if (!st?.dataset.verb) return;
  const pct = Math.floor((100 * n) / (li._meta.size || 1));
  if (st._pct === pct) return;
  st._pct = pct;
  st.querySelector("progress").value = pct / 100;
  st.querySelector(".pct").textContent = `${st.dataset.verb} ${pct}%`;
}

// addPending shows one of my messages ({text} or {file}) until the hub
// echoes it back.
function addPending(cid, content) {
  const li = buildMsg({ mine: true, from: S.me.id, name: S.me.name, ...content });
  li.classList.add("pending");
  li._ticks.textContent = "🕓";
  S.pending.set(cid, li);
  appendMsg(li, S.me.id, true);
  return li;
}

function sendFiles(files) {
  if (!S.session || !S.me || S.closed || !files.length) return;
  if (!may("files")) {
    system("Only the host can send files in this session.");
    return;
  }
  for (const file of files) {
    if (file.size > S.settings.maxFile) {
      system(`"${file.name}" is too big to send (${fmtSize(file.size)}, the limit is ${fmtSize(S.settings.maxFile)}).`);
      continue;
    }
    const cid = newCid();
    const meta = { name: file.name || "file", type: (file.type || "").toLowerCase(), size: file.size };
    const li = addPending(cid, { file: meta });
    li._file = file;
    li._local = fileEntry(file, meta);
    paintAtt(li);
    S.upQueue.push(cid);
  }
  pumpUploads();
}

// pumpUploads sends my files one at a time. If the connection drops, it
// stops; the next welcome queues what didn't make it and starts it again.
async function pumpUploads() {
  if (S.uploading) return;
  S.uploading = true;
  try {
    while (S.upQueue.length && S.session && !S.closed) {
      const cid = S.upQueue[0];
      const li = S.pending.get(cid);
      if (!li?._file) {
        S.upQueue.shift();
        continue;
      }
      try {
        await S.session.putFile(cid, li._file, (n) => setProgress(li, n));
        S.upQueue.shift();
      } catch (err) {
        if (!err.refused) break;
        S.upQueue.shift();
        S.pending.delete(cid);
        li._failed = { "too-big": "too big", "not-allowed": "only the host can send files" }[err.message] ?? err.message;
        li.classList.remove("pending");
        li._ticks.textContent = "⚠️";
        paintAtt(li);
      }
    }
  } finally {
    S.uploading = false;
  }
}

function wantFile(id) {
  if (S.blobs.has(id) || S.gone.has(id)) return;
  S.downQueue.add(id);
  pumpDownloads();
}

// pumpDownloads fetches received files one at a time, oldest first.
async function pumpDownloads() {
  if (S.downloading) return;
  S.downloading = true;
  try {
    for (const id of S.downQueue) {
      if (!S.session || S.closed) break;
      let li = findMsg(id);
      const meta = li?._meta;
      if (!meta || S.blobs.has(id)) {
        S.downQueue.delete(id);
        continue;
      }
      try {
        const blob = await S.session.getFile(id, meta, (n) => {
          if (!li?.isConnected) li = findMsg(id); // re-rendered by a welcome
          setProgress(li, n);
        });
        if (S.closed) break;
        S.downQueue.delete(id);
        const entry = fileEntry(blob, meta);
        S.blobs.set(id, entry);
        if (S.saveWhenDone.delete(id)) saveLink(entry).click();
      } catch (err) {
        if (!err.gone) break;
        S.downQueue.delete(id);
        S.saveWhenDone.delete(id);
        S.gone.add(id);
      }
      li = findMsg(id);
      if (li) paintAtt(li);
    }
  } finally {
    S.downloading = false;
  }
}

$("attach-btn").onclick = () => $("file-input").click();
$("camera-btn").onclick = () => $("camera-input").click();
for (const id of ["file-input", "camera-input"]) {
  $(id).onchange = (e) => {
    sendFiles([...e.target.files]);
    e.target.value = "";
  };
}

// Paste an image, or drop files on the chat.
$("input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  sendFiles(files);
});
{
  const chat = $("chat");
  const hint = $("drop-hint");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  chat.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    hint.hidden = false;
  });
  chat.addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      hint.hidden = true;
    }
  });
  chat.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  chat.addEventListener("drop", (e) => {
    depth = 0;
    hint.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    sendFiles([...e.dataTransfer.files]);
  });
}

// ---------- Photo viewer ----------
//
// Full screen, on top of the chat. It takes a history entry so that the
// Android back button closes it instead of leaving the page.

const viewer = $("viewer");

function openViewer(entry) {
  const img = $("viewer-img");
  img.src = entry.url;
  img.alt = entry.name;
  $("viewer-name").textContent = entry.name;
  const save = $("viewer-save");
  save.href = entry.url;
  save.download = entry.name;
  const sh = $("viewer-share");
  sh.hidden = !canShare(entry);
  sh.onclick = () => share(entry);
  viewer.showModal();
  history.pushState({ viewer: true }, "");
}

viewer.addEventListener("close", () => {
  $("viewer-img").removeAttribute("src");
  if (history.state?.viewer) history.back();
});
window.addEventListener("popstate", () => viewer.open && viewer.close());
$("viewer-close").onclick = () => viewer.close();
viewer.addEventListener("click", (e) => {
  if (e.target === viewer || e.target.classList.contains("viewer-stage")) viewer.close();
});

// ---------- Receipts ----------

function sendReceipts() {
  if (!S.session || S.closed || !S.settings.receipts) return;
  const delivered = S.lastMsgId;
  const seen = isActive() ? S.lastMsgId : S.sentReceipt.seen;
  if (delivered === S.sentReceipt.delivered && seen === S.sentReceipt.seen) return;
  S.sentReceipt = { delivered, seen };
  S.session.send({ t: "receipt", delivered, seen });
}

function onActivity() {
  if (!isActive()) return;
  S.unread = 0;
  updateTitle();
  sendReceipts();
}
window.addEventListener("focus", onActivity);
document.addEventListener("visibilitychange", onActivity);

// ---------- Composer ----------

const input = $("input");
let typingOn = false;
let typingIdle = null;

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

function stopTyping(notify) {
  clearTimeout(typingIdle);
  if (typingOn && notify) S.session?.send({ t: "typing", on: false });
  typingOn = false;
}

input.addEventListener("input", () => {
  autosize();
  if (!S.session) return;
  if (!input.value.trim()) return stopTyping(true);
  if (!typingOn && S.settings.typing) {
    typingOn = true;
    S.session.send({ t: "typing", on: true });
  }
  clearTimeout(typingIdle);
  typingIdle = setTimeout(() => stopTyping(true), 4000);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
  input.focus();
});

function sendMessage() {
  const text = input.value.slice(0, MAX_TEXT);
  if (!text.trim() || !S.session) return;
  const cid = newCid();
  addPending(cid, { text });
  S.session.send({ t: "msg", text, cid });
  stopTyping(false); // the hub clears our typing flag when the message arrives
  input.value = "";
  autosize();
}

// ---------- Sheets: settings and invite ----------

// Every sheet closes on a tap on its backdrop or on a [data-close] button.
// A press that starts inside (selecting the link…) and ends outside doesn't count.
for (const d of document.querySelectorAll("dialog.sheet")) {
  let downOnBackdrop = false;
  d.onpointerdown = (e) => (downOnBackdrop = e.target === d);
  d.onclick = (e) => {
    if ((e.target === d && downOnBackdrop) || e.target.closest("[data-close]")) d.close();
  };
}

function openSheet(d) {
  if (!d.open) d.showModal();
}

// changeSettings: the host changes some settings (the hub tells everyone).
function changeSettings(changes) {
  if (!amHost() || !S.session) return;
  // Show the cleaned-up value right away (e.g. 1 person becomes 2).
  fillOpts(liveOpts, cleanSettings({ ...S.settings, ...changes }));
  S.session.send({ t: "set", settings: changes });
}

$("lock-btn").onclick = () => changeSettings({ locked: !S.settings.locked });

const settingsSheet = $("settings");
const liveOpts = $("live-opts");
buildOpts(liveOpts, "live", { live: true, onEdit: (key, value) => changeSettings({ [key]: value }) });

$("settings-btn").onclick = () => {
  fillOpts(liveOpts, S.settings);
  openSheet(settingsSheet);
};

const inviteSheet = $("invite");
const openInvite = () => openSheet(inviteSheet);
$("invite-btn").onclick = openInvite;
inviteSheet.addEventListener("close", () => {
  if (S.me && !S.closed && !input.disabled && matchMedia("(pointer: fine)").matches) input.focus();
});
$("invite-link").onclick = (e) => e.target.select();

$("copy-btn").onclick = async () => {
  const btn = $("copy-btn");
  try {
    await navigator.clipboard.writeText(linkTo(S.addr));
  } catch {
    $("invite-link").select();
    document.execCommand?.("copy");
  }
  btn.textContent = "Copied ✓";
  setTimeout(() => (btn.textContent = "Copy the link"), 1500);
};

if (navigator.share) {
  // On phones, sharing is the main way: copying comes second.
  $("share-btn").hidden = false;
  $("copy-btn").classList.remove("primary");
  $("share-btn").onclick = () =>
    navigator
      .share({
        title: "ShitChat",
        text: "Join my ShitChat session (it self-destructs when I leave):",
        url: linkTo(S.addr),
      })
      .catch(() => {});
}

// ---------- Leaving ----------

$("leave-btn").onclick = async () => {
  if (!S.session) return;
  const ok =
    !S.isHost ||
    confirm("Destroy the session? Everyone will be disconnected and the link will never work again.");
  // Fires a "closed" event ("destroyed" for the host, "left" for a guest).
  if (ok) await S.session.close();
};

// Pasting another invite link in the address bar only changes the
// fragment: the page doesn't reload by itself. Leave the current session
// (after asking), then reload to join the new one.
window.addEventListener("hashchange", async () => {
  const h = takeInviteFromHash();
  if (!h) return;
  if (S.starting || (S.session && !S.closed)) {
    if (h === S.addr) return; // that's this very session
    const ok = confirm(
      S.isHost || S.starting
        ? "Join the other session? Yours will be destroyed: everyone is disconnected and its link dies."
        : "Leave this session and join the other one?",
    );
    if (!ok) return;
    // Still starting: nothing to close, the reload stops it all.
    const s = S.session;
    S.session = null;
    S.closed = true;
    if (s) await Promise.race([s.close(), new Promise((r) => setTimeout(r, 2000))]);
  }
  forget();
  history.replaceState(null, "", `${baseURL}${location.search}#${encodeURIComponent(h)}`);
  location.reload();
});

// Closing the host's tab destroys the session: ask first.
window.addEventListener("beforeunload", (e) => {
  if (S.isHost && S.session && !S.closed) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// The page is going away: maybe a reload, maybe the tab closing. Keep
// the seat either way (sessionStorage only outlives a reload), and warn
// the others so they reconnect right away.
window.addEventListener("pagehide", () => {
  if (!S.session || S.closed) return;
  if (S.isHost) saveHost();
  S.session.away();
  touch();
});

// ---------- Go ----------

if (inviteAddr) {
  $("invite-note").hidden = false;
  passwordInput.hidden = true;
  advanced.hidden = true;
  primaryBtn.textContent = "Join the session";
}

const savedSession = resumable();

try {
  await bootWasm();
} catch (err) {
  primaryBtn.classList.remove("loading");
  primaryBtn.textContent = "Unavailable";
  setStatus(`Couldn't load the WebAssembly engine: ${err.message}`, true);
  throw err;
}

const saved = await savedSession;
if (saved) advanced.hidden = true;
if (saved?.role === "host") {
  hostSession(saved);
} else if (saved?.role === "guest") {
  inviteAddr = saved.addr;
  joinSession(saved.resume);
} else if (inviteAddr) {
  joinSession();
} else {
  setFormDisabled(false);
  primaryBtn.textContent = "Create a session";
}
