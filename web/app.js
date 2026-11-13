// ShitChat UI. Plain JavaScript, no build step.
//
// The tailcat WebAssembly module (built from github.com/tailscale/tailcat's
// web/ package) exposes two globals: tailcatListen and tailcatDial.
// core.js implements the chat protocol on top of them.

import { Hub, join, makeSecret, HOST_ID, MAX_TEXT, MAX_FILE, PROTO, GRACE_MS } from "./core.js";
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
// never send to the web server. Read it once, then wipe it from the
// address bar and history.
let inviteAddr = null;
{
  const h = decodeURIComponent(location.hash.slice(1)).trim();
  if (h.startsWith("tc")) {
    inviteAddr = h;
    history.replaceState(null, "", baseURL + location.search);
  }
}

const S = {
  session: null, // {send(msg), close()} + pause() (host) or away() (guest)
  hub: null, // host only
  isHost: false,
  resumed: false, // picked up after a reload
  closed: false,
  authPending: false, // guest: the host asked for the password
  me: null, // {id, name, token}
  hostId: HOST_ID,
  addr: "",
  link: "",
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
};

// ---------- Small helpers ----------

function setScreen(name) {
  document.body.dataset.screen = name;
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function hue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function avatar(name) {
  const span = document.createElement("span");
  span.className = "avatar";
  span.style.setProperty("--hue", hue(name));
  span.textContent = name.slice(0, 1);
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
  const bar = $("load-progress");
  let resp = await fetch("main.wasm.gz");
  let gzipped = resp.ok;
  if (!gzipped) {
    resp = await fetch("main.wasm");
    if (!resp.ok) throw new Error(`main.wasm: HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get("Content-Length")) || 0;
  let loaded = 0;
  let body = resp.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        if (total) {
          bar.value = loaded / total;
          const mb = (total / (1 << 20)).toFixed(1);
          setStatus(`Loading the WireGuard engine… ${Math.floor((100 * loaded) / total)}% of ${mb} MB`);
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

function busy(text) {
  primaryBtn.disabled = true;
  passwordInput.disabled = true;
  setStatus(text);
}

function failed(text) {
  primaryBtn.disabled = false;
  passwordInput.disabled = false;
  setStatus(text, true);
}

// hostSession creates a session, or resumes the saved one after a reload.
async function hostSession(saved = null) {
  busy(saved ? "Restoring your session…" : "Creating the session…");
  let hub = null;
  try {
    const password = saved ? "" : passwordInput.value;
    const secret = password ? await makeSecret(password) : null;
    hub = new Hub({ makeName: randomName, snapshot: saved?.hub, secret, onChange: saveHostSoon });
    const addr = await hub.listen(globalThis.tailcatListen, { derpMapURL, verbose });
    S.isHost = true;
    S.resumed = !!saved;
    S.hub = hub;
    S.addr = addr;
    S.link = `${baseURL}#${addr}`;
    saveHost();
    S.session = hub.openLocal(onEvent);
    passwordInput.value = "";
    $("invite-open").hidden = !!hub.secret;
    $("invite-locked").hidden = !hub.secret;
    $("invite").hidden = !!saved;
  } catch (err) {
    hub?.end();
    forget();
    inviteAddr = null;
    $("invite-note").hidden = true;
    primaryBtn.textContent = "Create a session";
    failed(`Couldn't ${saved ? "restore" : "create"} the session: ${err.message}`);
  }
}

// joinSession joins inviteAddr, or takes our seat back after a reload.
async function joinSession(resume = null) {
  busy(
    resume
      ? "Reconnecting to the session…"
      : "Connecting to the session… (if it no longer exists, this fails after a minute)",
  );
  try {
    S.resumed = !!resume;
    S.addr = inviteAddr;
    S.link = `${baseURL}#${inviteAddr}`;
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
  passwordInput.hidden = false;
  passwordInput.disabled = false;
  passwordInput.required = true;
  passwordInput.placeholder = "Password";
  passwordInput.setAttribute("aria-label", "Password");
  passwordInput.autocomplete = "current-password";
  primaryBtn.textContent = "Join";
  primaryBtn.disabled = false;
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
  S.hostId = m.hostId;
  if (!S.isHost) save({ role: "guest", addr: S.addr, resume: { id: m.you.id, token: m.you.token } });
  setPeers(m.peers);
  S.typing.clear();
  // Messages typed while disconnected (or lost in the cut) that the hub
  // never got: send them again below.
  const unsent = [...S.pending].filter(
    ([cid]) => !m.messages.some((x) => x.cid === cid && x.from === m.you.id),
  );
  for (const [cid, li] of S.pending) {
    const done = li._local && m.messages.find((x) => x.cid === cid && x.from === m.you.id);
    if (done && !S.blobs.has(done.id)) S.blobs.set(done.id, li._local);
  }
  S.pending.clear();
  S.mine.clear();
  S.lastMsgId = 0;
  S.sentReceipt = { delivered: 0, seen: 0 };
  $("messages").replaceChildren();
  for (const msg of m.messages) renderMsg(msg);
  if (!first || S.resumed) {
    system(S.isHost ? `Session restored. You are still ${S.me.name}.` : `Reconnected. You are ${S.me.name}.`);
  } else {
    system(
      S.isHost
        ? `Session created. You are ${S.me.name}. Share the link to invite people.`
        : `You joined the session as ${S.me.name}.`,
    );
  }
  S.upQueue = S.upQueue.filter((cid) => unsent.some(([c]) => c === cid));
  for (const [cid, li] of unsent) {
    li.classList.remove("cont");
    S.pending.set(cid, li);
    appendMsg(li, S.me.id, true);
    if (li._file) {
      if (!S.upQueue.includes(cid)) S.upQueue.push(cid);
    } else {
      S.session?.send({ t: "msg", text: li.querySelector(".text").textContent, cid });
    }
  }
  pumpUploads();
  pumpDownloads();
  $("conn").hidden = true;
  $("invite-link").value = S.link;
  $("leave-btn").textContent = S.isHost ? "Destroy" : "Leave";
  setScreen("chat");
  renderRoster();
  renderTyping();
  refreshTicks();
  sendReceipts();
  scrollToBottom(true);
  if (first) $("input").focus();
}

function onReconnecting(m) {
  stopTyping(false);
  S.typing.clear();
  renderTyping();
  if (!S.me) return; // resuming after a reload: the home screen shows the status
  const until = fmtTime(m.until);
  const el = $("conn");
  el.textContent = `Lost the connection to the host. Reconnecting… (giving up at ${until})`;
  el.hidden = false;
}

const ROSTER_VERBS = {
  join: "joined the session",
  back: "is back",
  lost: "lost the connection",
  leave: "left",
};

function onRoster(m) {
  setPeers(m.peers);
  if (m.event) system(`${m.event.name} ${ROSTER_VERBS[m.event.kind] ?? "left"}.`);
  renderRoster();
  renderTyping();
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

function onClosed(reason) {
  if (reason === "ended") {
    showEnded("Session destroyed", "The host ended the session. The messages are gone and the link is dead.");
  } else if (reason === "left") {
    showEnded("You left", "You left the session. The messages are gone from this tab.");
  } else if (reason === "replaced") {
    showEnded("Opened elsewhere", "This session was picked up in another tab, so this one stepped aside.");
  } else if (reason === "denied") {
    showEnded(
      "Access denied",
      "Too many wrong passwords, or it took too long to type one. Open the link again to retry.",
    );
  } else if (reason === "expired") {
    showEnded(
      "Session expired",
      "This page was asleep for too long and the guests gave up, so the session was destroyed. The link is dead.",
    );
  } else {
    showEnded(
      "Session over",
      S.me
        ? "Lost contact with the host for too long: they probably closed their tab, so the session no longer exists."
        : "Couldn't get back to the session: the host probably closed their tab, so it no longer exists.",
    );
  }
}

function showEnded(title, text) {
  S.closed = true;
  S.session = null;
  S.hub = null;
  forget();
  $("conn").hidden = true;
  S.peers.clear();
  S.pending.clear();
  S.mine.clear();
  if (viewer.open) viewer.close();
  for (const e of S.blobs.values()) URL.revokeObjectURL(e.url);
  S.blobs.clear();
  S.gone.clear();
  S.upQueue = [];
  S.downQueue.clear();
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
  const li = document.createElement("li");
  li.className = "system";
  li.textContent = text;
  $("messages").append(li);
  scrollToBottom(stick);
}

function buildMsg({ mine, from, name, text, file }) {
  const li = document.createElement("li");
  li.className = `msg ${mine ? "mine" : "theirs"}`;
  li.dataset.from = from;
  li.style.setProperty("--hue", hue(name));

  const author = document.createElement("div");
  author.className = "author";
  author.textContent = name;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  let p;
  if (file) {
    bubble.classList.add("has-file");
    p = document.createElement("div");
    p.className = "att";
    li._meta = file;
  } else {
    p = document.createElement("p");
    p.className = "text";
    p.textContent = text;
  }
  const meta = document.createElement("span");
  meta.className = "meta";
  const time = document.createElement("time");
  const ticks = document.createElement("span");
  ticks.className = "ticks";
  meta.append(time, ticks);
  bubble.append(p, meta);

  const receipt = document.createElement("div");
  receipt.className = "receipt";

  li.append(author, bubble, receipt);
  return li;
}

function appendMsg(li, from, force) {
  const list = $("messages");
  const stick = force || nearBottom();
  const prev = list.lastElementChild;
  if (prev && prev.classList.contains("msg") && prev.dataset.from === String(from)) {
    li.classList.add("cont");
  }
  list.append(li);
  scrollToBottom(stick);
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
    paintAtt(li);
    wantFile(m.id);
  }
  li.querySelector("time").textContent = fmtTime(m.ts);
  S.lastMsgId = Math.max(S.lastMsgId, m.id);
  if (mine) {
    S.mine.set(m.id, li);
    refreshTicks();
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
    const st = statusFor(id, others);
    const t = li.querySelector(".ticks");
    t.textContent = st.ticks;
    t.className = `ticks ${st.cls}`;
    t.title = st.label;
    li.querySelector(".receipt").textContent = id === lastId ? st.label : "";
  }
}

function renderRoster() {
  const ul = $("roster");
  ul.replaceChildren();
  for (const p of S.peers.values()) {
    const li = document.createElement("li");
    if (p.id === S.me.id) li.className = "me";
    li.append(avatar(p.name), p.name);
    const tags = [];
    if (p.id === S.me.id) tags.push("you");
    if (p.id === S.hostId) tags.push("host");
    if (tags.length) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = `(${tags.join(", ")})`;
      li.append(b);
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

function el(tag, cls, text) {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (text !== undefined) x.textContent = text;
  return x;
}

function saveLink(e) {
  const a = el("a", "btn small", "Save");
  a.href = e.url;
  a.download = e.name;
  return a;
}

// paintAtt (re)draws a file message's attachment for its current state.
function paintAtt(li) {
  const box = li.querySelector(".att");
  if (!box) return;
  const meta = li._meta;
  const id = Number(li.dataset.id) || 0;
  const pending = li.classList.contains("pending");
  const entry = (id && S.blobs.get(id)) || li._local || null;
  const state = li._failed
    ? "failed"
    : pending
      ? "sending"
      : entry
        ? "ready"
        : S.gone.has(id)
          ? "gone"
          : "receiving";
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
  if (!media) info.append(el("span", "fileicon", "📄"));
  const label = el("div", "filelabel");
  const fname = el("span", "filename", meta.name);
  fname.title = meta.name;
  label.append(fname, el("span", "filesize", fmtSize(meta.size)));
  info.append(label);
  bar.append(info);
  if (state === "ready") {
    const actions = el("div", "fileactions");
    actions.append(saveLink(entry));
    if (!media && canShare(entry)) {
      const b = el("button", "btn small", "Share");
      b.type = "button";
      b.onclick = () => share(entry);
      actions.append(b);
    }
    bar.append(actions);
  }
  box.append(bar);

  if (state === "sending" || state === "receiving") {
    const st = el("div", "att-status");
    const prog = el("progress");
    prog.max = 1;
    prog.value = 0;
    st.append(prog, el("span", "pct", state === "sending" ? "Sending…" : "Receiving…"));
    st.dataset.verb = state === "sending" ? "Sending" : "Receiving";
    box.append(st);
  } else if (state === "gone") {
    box.append(el("div", "att-status note-text", "No longer available (the host reloaded)."));
  } else if (state === "failed") {
    box.append(el("div", "att-status note-text", `Not sent: ${li._failed}.`));
  }
}

function setProgress(li, n) {
  const st = li?.querySelector(".att-status");
  if (!st?.dataset.verb) return;
  const size = li._meta.size || 1;
  st.querySelector("progress").value = n / size;
  st.querySelector(".pct").textContent = `${st.dataset.verb} ${Math.floor((100 * n) / size)}%`;
}

function sendFiles(files) {
  if (!S.session || !S.me || S.closed) return;
  for (const file of files) {
    if (file.size > MAX_FILE) {
      system(`"${file.name}" is too big to send (${fmtSize(file.size)}, the limit is ${fmtSize(MAX_FILE)}).`);
      continue;
    }
    const cid = newCid();
    const meta = { name: file.name || "file", type: (file.type || "").toLowerCase(), size: file.size };
    const li = buildMsg({ mine: true, from: S.me.id, name: S.me.name, file: meta });
    li._file = file;
    li._local = fileEntry(file, meta);
    li.classList.add("pending");
    li.querySelector(".ticks").textContent = "🕓";
    S.pending.set(cid, li);
    appendMsg(li, S.me.id, true);
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
        li._failed = err.message === "too-big" ? "too big" : err.message;
        li.classList.remove("pending");
        li.querySelector(".ticks").textContent = "⚠️";
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
      const meta = findMsg(id)?._meta;
      if (!meta || S.blobs.has(id)) {
        S.downQueue.delete(id);
        continue;
      }
      try {
        const blob = await S.session.getFile(id, meta, (n) => setProgress(findMsg(id), n));
        if (S.closed) break;
        S.downQueue.delete(id);
        S.blobs.set(id, fileEntry(blob, meta));
      } catch (err) {
        if (!err.gone) break;
        S.downQueue.delete(id);
        S.gone.add(id);
      }
      const li = findMsg(id);
      if (li) paintAtt(li);
    }
  } finally {
    S.downloading = false;
  }
}

$("attach-btn").onclick = () => $("file-input").click();
$("camera-btn").hidden = !matchMedia("(pointer: coarse)").matches;
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
  if (!S.session || S.closed) return;
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
  if (!typingOn) {
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
  const li = buildMsg({ mine: true, from: S.me.id, name: S.me.name, text });
  li.classList.add("pending");
  li.querySelector(".ticks").textContent = "🕓";
  S.pending.set(cid, li);
  appendMsg(li, S.me.id, true);
  S.session.send({ t: "msg", text, cid });
  // The hub clears our typing flag when the message arrives.
  clearTimeout(typingIdle);
  typingOn = false;
  input.value = "";
  autosize();
}

// ---------- Invite / leave ----------

$("invite-btn").onclick = () => {
  $("invite").hidden = !$("invite").hidden;
};

$("copy-btn").onclick = async () => {
  const btn = $("copy-btn");
  try {
    await navigator.clipboard.writeText(S.link);
  } catch {
    $("invite-link").select();
    document.execCommand?.("copy");
  }
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = "Copy"), 1500);
};

if (navigator.share) {
  $("share-btn").hidden = false;
  $("share-btn").onclick = () =>
    navigator
      .share({
        title: "ShitChat",
        text: "Join my ShitChat session (it self-destructs when I leave):",
        url: S.link,
      })
      .catch(() => {});
}

$("leave-btn").onclick = async () => {
  if (!S.session) return;
  if (S.isHost) {
    const ok = confirm(
      "Destroy the session? Everyone will be disconnected and the link will never work again.",
    );
    if (!ok) return;
    const s = S.session;
    showEnded("Session destroyed", "You destroyed the session. The messages are gone and the link is dead.");
    await s.close();
  } else {
    await S.session.close(); // fires a "closed: left" event
  }
};

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
  if (S.isHost) {
    saveHost();
    S.session.pause();
  } else {
    S.session.away();
  }
  touch();
});

// ---------- Go ----------

if (inviteAddr) {
  $("invite-note").hidden = false;
  passwordInput.hidden = true;
  primaryBtn.textContent = "Join the session";
}

const savedSession = resumable();

try {
  await bootWasm();
} catch (err) {
  setStatus(`Couldn't load the WebAssembly engine: ${err.message}`, true);
  throw err;
}
$("load-progress").hidden = true;

const saved = await savedSession;
if (saved?.role === "host") {
  hostSession(saved);
} else if (saved?.role === "guest") {
  inviteAddr = saved.addr;
  joinSession(saved.resume);
} else if (inviteAddr) {
  joinSession();
} else {
  primaryBtn.disabled = false;
  passwordInput.disabled = false;
  setStatus("Ready.");
}
