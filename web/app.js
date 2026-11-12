// ShitChat UI. Plain JavaScript, no build step.
//
// The tailcat WebAssembly module (built from github.com/tailscale/tailcat's
// web/ package) exposes two globals: tailcatListen and tailcatDial.
// core.js implements the chat protocol on top of them.

import { Hub, join, HOST_ID, MAX_TEXT, PROTO, GRACE_MS } from "./core.js";
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

function busy(text) {
  primaryBtn.disabled = true;
  setStatus(text);
}

function failed(text) {
  primaryBtn.disabled = false;
  setStatus(text, true);
}

// hostSession creates a session, or resumes the saved one after a reload.
async function hostSession(saved = null) {
  busy(saved ? "Restoring your session…" : "Creating the session…");
  const hub = new Hub({ makeName: randomName, snapshot: saved?.hub, onChange: saveHostSoon });
  try {
    const addr = await hub.listen(globalThis.tailcatListen, { derpMapURL, verbose });
    S.isHost = true;
    S.resumed = !!saved;
    S.hub = hub;
    S.addr = addr;
    S.link = `${baseURL}#${addr}`;
    saveHost();
    S.session = hub.openLocal(onEvent);
    $("invite").hidden = !!saved;
  } catch (err) {
    hub.end();
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

primaryBtn.onclick = () => (inviteAddr ? joinSession() : hostSession());

// ---------- Protocol events ----------

function onEvent(m) {
  if (S.closed) return;
  switch (m.t) {
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
  for (const [cid, li] of unsent) {
    li.classList.remove("cont");
    S.pending.set(cid, li);
    appendMsg(li, S.me.id, true);
    S.session?.send({ t: "msg", text: li.querySelector(".text").textContent, cid });
  }
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

function buildMsg({ mine, from, name, text }) {
  const li = document.createElement("li");
  li.className = `msg ${mine ? "mine" : "theirs"}`;
  li.dataset.from = from;
  li.style.setProperty("--hue", hue(name));

  const author = document.createElement("div");
  author.className = "author";
  author.textContent = name;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const p = document.createElement("p");
  p.className = "text";
  p.textContent = text;
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
  } else {
    li = buildMsg({ mine, from: m.from, name: m.name, text: m.text });
    appendMsg(li, m.from, mine);
  }
  li.dataset.id = m.id;
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
  const cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
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
  setStatus("Ready.");
}
