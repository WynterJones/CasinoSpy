import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { marked } from "marked";
import { loadSettings, patchSettings } from "./settings.js";
import {
  getSession, startSession, adjustCurrent, setCurrent,
  winLoss, money, wlState, onSessionChange,
} from "./session.js";

const $ = (id) => document.getElementById(id);
const win = getCurrentWindow();
const CHAT_MODEL = "sonnet";

const GREETING =
  "Good evening — **Jiffrey** at your service. Set a buy-in to start a session, then tell me what you're playing.";

const PERSONA = `You are Jiffrey, a warm, witty British casino butler and responsible-gambling guide inside an app called CasinoSpy.
Be honest and never misleading:
- All casino games are negative expected value over time. SLOTS are pure RNG with a fixed RTP — no bet size, timing, or system changes the odds; never imply otherwise.
- For blackjack and video poker you may explain correct basic/optimal strategy (these reduce the house edge but never guarantee a profit).
- Never promise wins or "systems" that beat RNG. Encourage limits, breaks, and walking away while ahead.
- If the user seems to be chasing losses or in distress, gently suggest stopping and mention OLG PlaySmart (playsmart.ca) and self-exclusion.
You can see the user's live session (buy-in, current total, win/loss). Keep replies concise and friendly with light butler flair. Use markdown.`;

// ---------- chat store (multiple threads) ----------
function genId() {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function getStore() {
  const j = loadSettings().jiffrey || {};
  let chats = Array.isArray(j.chats) ? j.chats : [];
  // migrate legacy single-thread format
  if (!chats.length && Array.isArray(j.messages) && j.messages.length) {
    chats = [{ id: genId(), title: "Chat", messages: j.messages }];
  }
  return { chats, activeId: j.activeId || (chats[0] && chats[0].id) || null };
}
function saveStore(store) {
  patchSettings({ jiffrey: { chats: store.chats, activeId: store.activeId } });
}
function newThread(store) {
  const chat = { id: genId(), title: "New chat", messages: [{ role: "assistant", content: GREETING }] };
  store.chats.unshift(chat);
  store.activeId = chat.id;
  return chat;
}
function activeChat(store) {
  let c = store.chats.find((x) => x.id === store.activeId);
  if (!c) c = newThread(store);
  return c;
}

let store = getStore();
if (!store.chats.length) newThread(store);
saveStore(store);

// ---------- render messages ----------
function renderMsgs() {
  const wrap = $("msgs");
  const chat = activeChat(store);
  wrap.innerHTML = "";
  for (const m of chat.messages) {
    const row = document.createElement("div");
    row.className = "msg " + (m.role === "assistant" ? "from-jiffrey" : "from-user");
    row.innerHTML = m.role === "assistant"
      ? `<img class="msg-av" src="/assets/jiffrey.png" alt="" /><div class="bubble">${marked.parse(m.content)}</div>`
      : `<div class="bubble">${escapeHtml(m.content)}</div>`;
    wrap.appendChild(row);
  }
  wrap.scrollTop = wrap.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---------- history drawer ----------
function snippet(chat) {
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  const t = (lastUser ? lastUser.content : chat.messages[chat.messages.length - 1]?.content || "").replace(/\s+/g, " ");
  return t.slice(0, 48);
}
function renderList() {
  const ul = $("chatList");
  ul.innerHTML = "";
  for (const c of store.chats) {
    const li = document.createElement("li");
    li.className = "chat-list-item" + (c.id === store.activeId ? " active" : "");
    li.innerHTML = `<div class="cli-main"><span class="cli-title">${escapeHtml(c.title || "Chat")}</span>
      <span class="cli-snip">${escapeHtml(snippet(c))}</span></div>
      <button class="cli-del" data-id="${c.id}" title="Delete">&times;</button>`;
    li.querySelector(".cli-main").onclick = () => { store.activeId = c.id; saveStore(store); renderMsgs(); renderList(); closeDrawer(); };
    li.querySelector(".cli-del").onclick = (e) => {
      e.stopPropagation();
      store.chats = store.chats.filter((x) => x.id !== c.id);
      if (store.activeId === c.id) store.activeId = store.chats[0] ? store.chats[0].id : null;
      if (!store.chats.length) newThread(store);
      saveStore(store);
      renderMsgs(); renderList();
    };
    ul.appendChild(li);
  }
}
function openDrawer() { renderList(); $("drawer").hidden = false; $("scrim").hidden = false; }
function closeDrawer() { $("drawer").hidden = true; $("scrim").hidden = true; }
$("chatMenu").addEventListener("click", openDrawer);
$("drawerClose").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
$("chatNewHdr").addEventListener("click", () => { newThread(store); saveStore(store); renderMsgs(); renderList(); closeDrawer(); });

// ---------- session box ----------
function renderSess() {
  const box = $("chatSess");
  const s = getSession();
  if (!s.active) {
    box.className = "chat-sess idle";
    box.innerHTML = `<input class="sess-buyin sm" id="cBuy" type="number" min="0" step="0.01" placeholder="Buy-in $" />
      <button class="mini" id="cStart" type="button">Start</button>`;
    $("cStart").onclick = () => {
      const b = parseFloat($("cBuy").value);
      if (!Number.isFinite(b) || b < 0) { $("cBuy").focus(); return; }
      startSession(b); renderSess();
    };
    return;
  }
  const st = wlState(winLoss(s));
  box.className = "chat-sess live " + st.cls;
  box.innerHTML = `<button class="mini cbtn" id="cMinus" type="button">&minus;</button>
    <div class="cs-mid"><input class="cs-amt" id="cAmt" type="number" min="0" step="0.01" />
    <span class="cs-wl">${st.cls === "even" ? "Even" : st.text}</span></div>
    <button class="mini cbtn" id="cPlus" type="button">+</button>`;
  const amt = $("cAmt");
  if (document.activeElement !== amt) amt.value = s.current.toFixed(2);
  $("cPlus").onclick = () => { adjustCurrent(5); renderSess(); };
  $("cMinus").onclick = () => { adjustCurrent(-5); renderSess(); };
  amt.onchange = () => { setCurrent(amt.value); renderSess(); };
}

function sessionContext() {
  const s = getSession();
  if (!s.active) return "Session: none active.";
  const wl = winLoss(s);
  return `Session: ACTIVE. Buy-in ${money(s.buyIn)}, current ${money(s.current)}, ` +
    `${wl > 0 ? "up " + money(wl) : wl < 0 ? "down " + money(wl) : "even"}.`;
}
function buildPrompt(history, latest) {
  const convo = history.map((m) => `${m.role === "assistant" ? "Jiffrey" : "User"}: ${m.content}`).join("\n");
  return `${PERSONA}\n\n[${sessionContext()}]\n\nConversation so far:\n${convo}\n\nUser: ${latest}\n\nReply as Jiffrey (markdown, concise):`;
}

// ---------- send ----------
let busy = false;
async function send() {
  if (busy) return;
  const text = $("chatText").value.trim();
  if (!text) return;
  busy = true;
  $("chatText").value = "";
  autoGrow();

  const chat = activeChat(store);
  const history = chat.messages.slice();
  chat.messages.push({ role: "user", content: text });
  if (chat.title === "New chat" || !chat.title) chat.title = text.slice(0, 34);
  saveStore(store);
  renderMsgs();

  const wrap = $("msgs");
  const typing = document.createElement("div");
  typing.className = "msg from-jiffrey";
  typing.innerHTML = `<img class="msg-av" src="/assets/jiffrey.png" alt="" /><div class="bubble typing"><span></span><span></span><span></span></div>`;
  wrap.appendChild(typing);
  wrap.scrollTop = wrap.scrollHeight;

  try {
    const reply = await invoke("chat_reply", { prompt: buildPrompt(history, text), model: CHAT_MODEL });
    chat.messages.push({ role: "assistant", content: (reply || "").trim() || "…" });
  } catch (e) {
    chat.messages.push({ role: "assistant", content: "Apologies — I couldn't reach my study just now.\n\n`" + e + "`" });
  } finally {
    busy = false;
    saveStore(store);
    renderMsgs();
  }
}
function autoGrow() {
  const t = $("chatText");
  t.style.height = "auto";
  t.style.height = Math.min(120, t.scrollHeight) + "px";
}

$("chatSend").addEventListener("click", send);
$("chatText").addEventListener("input", autoGrow);
$("chatText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("chatClose").addEventListener("click", () => win.close());
onSessionChange(renderSess);

renderMsgs();
renderSess();
