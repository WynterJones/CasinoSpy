import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./settings.js";
import { parseBlackjack, parseVideoPoker } from "./scan.js";
import { bestMove, handTotal } from "./strategy.js";
import { bestHold, parseCard } from "./videopoker.js";

const $ = (id) => document.getElementById(id);
const win = getCurrentWindow();
const SUIT_GLYPH = { c: "♣", d: "♦", h: "♥", s: "♠" };
const SUIT_FROM_IDX = ["c", "d", "h", "s"];

let scanning = false;
let autoOn = false;
let autoTimer = null;

// ---- card rendering ----
function makeCard(rank, suit) {
  const el = document.createElement("div");
  const known = !!suit && SUIT_GLYPH[suit];
  el.className = "pcard" + (suit === "h" || suit === "d" ? " red" : "") + (known ? "" : " noSuit");
  const g = known ? SUIT_GLYPH[suit] : "";
  el.innerHTML = `
    <span class="c-rank">${rank || "?"}</span>
    <span class="c-suit-tl">${g}</span>
    <span class="c-pip">${g || "•"}</span>`;
  return el;
}

function renderCards(container, cards) {
  container.innerHTML = "";
  if (!cards.length) {
    container.innerHTML = `<div class="pcard empty"><span class="c-pip">—</span></div>`;
    return;
  }
  for (const c of cards) container.appendChild(makeCard(c.rank, c.suit));
}

function setMove(action, label, reason) {
  const el = $("move");
  el.className = "move " + action;
  el.textContent = label;
  $("moveReason").textContent = reason || "";
}

function setStatusDot(color) {
  $("statusDot").style.color = color;
}

function showView(mode) {
  $("bjView").style.display = mode === "blackjack" ? "" : "none";
  $("vpView").style.display = mode === "videopoker" ? "" : "none";
}

function setConfidence(conf, note) {
  const wrap = $("confWrap");
  if (conf == null) {
    wrap.style.visibility = "hidden";
    return;
  }
  wrap.style.visibility = "visible";
  const pct = Math.round(conf * 100);
  $("confPct").textContent = pct + "%";
  const fill = $("confFill");
  fill.style.width = pct + "%";
  let color = "#ff625d";
  if (conf >= 0.85) color = "#2ed178";
  else if (conf >= 0.6) color = "#f2c94c";
  fill.style.background = color;
  $("confPct").style.color = color;
  $("confNote").textContent = note || "";
}

// ---- progress ----
function progressShow(title) {
  const p = $("scanProgress");
  p.hidden = false;
  $("spTitle").textContent = title || "Reading hand…";
  for (const li of p.querySelectorAll(".sp-step")) li.className = "sp-step";
}
function progressStep(step) {
  const p = $("scanProgress");
  const order = ["capturing", "reading", "analyzing"];
  const idx = order.indexOf(step);
  p.querySelectorAll(".sp-step").forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.className = "sp-step" + (i < idx ? " done" : i === idx ? " active" : "");
  });
}
function progressHide() {
  $("scanProgress").hidden = true;
}

// ---- scan ----
async function doScan() {
  if (scanning) return;
  const s = loadSettings();
  if (!s.region) return setMove("ERR", "NO AREA", "Pick a region in control panel");

  showView(s.gameMode);
  scanning = true;
  setStatusDot("#f2c94c");
  progressShow(s.gameMode === "videopoker" ? "Reading hand…" : "Reading table…");
  progressStep("capturing");

  try {
    const raw = await invoke("scan", { region: s.region, mode: s.gameMode, model: "opus" });
    progressStep("analyzing");
    if (s.gameMode === "videopoker") renderVideoPoker(raw, s);
    else renderBlackjack(raw, s);
    await delay(220);
  } catch (e) {
    setMove("ERR", "ERROR", String(e));
    setConfidence(null);
    setStatusDot("#ff625d");
  } finally {
    progressHide();
    scanning = false;
  }
}

function renderBlackjack(raw, s) {
  const parsed = parseBlackjack(raw);
  if (parsed.error) {
    setMove("ERR", "READ?", parsed.error);
    setConfidence(null);
    setStatusDot("#ff625d");
    return;
  }
  renderCards($("playerCards"), parsed.player);
  renderCards($("dealerCards"), parsed.dealer ? [parsed.dealer] : []);

  const ranks = parsed.player.map((c) => c.rank);
  if (ranks.length >= 2) {
    const t = handTotal(ranks);
    $("playerTotal").textContent = (t.soft ? "Soft " : "") + t.total;
  } else {
    $("playerTotal").textContent = "";
  }

  setConfidence(parsed.confidence, parsed.notes);

  if (ranks.length < 2 || !parsed.dealer) {
    setMove("WAIT", "WAITING", "Need 2+ cards and dealer up-card");
    setStatusDot("#b8c8b7");
    return;
  }
  const move = bestMove(ranks, parsed.dealer.rank, s.rules);
  setMove(move.action, move.label, move.reason);
  setStatusDot("#2ed178");
}

function renderVideoPoker(raw, s) {
  const parsed = parseVideoPoker(raw);
  if (parsed.error) {
    setMove("ERR", "READ?", parsed.error);
    setConfidence(null);
    setStatusDot("#ff625d");
    return;
  }
  const cards = parsed.cards.map(parseCard);
  setConfidence(parsed.confidence, parsed.notes);

  if (cards.length !== 5 || cards.some((c) => !c)) {
    setMove("WAIT", "WAITING", `Need 5 cards (read ${parsed.cards.length})`);
    renderVpCards(parsed.cards.map((c) => ({ rank: (c || "").replace(/[cdhs]$/, ""), suit: (c || "").slice(-1), hold: false })));
    setStatusDot("#b8c8b7");
    return;
  }
  const r = bestHold(cards, s.vpPaytable);
  const holdSet = new Set(r.holdIdx);
  renderVpCards(
    cards.map((c, i) => ({ rank: rankStr(c.rank), suit: SUIT_FROM_IDX[c.suit], hold: holdSet.has(i) }))
  );
  setMove("HOLD", r.holdIdx.length ? "HOLD" : "DRAW 5", r.label);
  setConfidence(parsed.confidence, `EV ${r.ev.toFixed(2)} coins · ${parsed.notes}`);
  setStatusDot("#2ed178");
}

function rankStr(rank) {
  return ({ 0: "JKR", 14: "A", 13: "K", 12: "Q", 11: "J" })[rank] || String(rank);
}

function renderVpCards(items) {
  const wrap = $("vpCards");
  wrap.innerHTML = "";
  for (const it of items) {
    const slot = document.createElement("div");
    slot.className = "vp-slot" + (it.hold ? " hold" : " drop");
    const card = makeCard(it.rank, it.suit);
    if (it.hold) card.classList.add("held");
    slot.appendChild(card);
    const tag = document.createElement("span");
    tag.className = "vp-tag";
    tag.textContent = it.hold ? "HOLD" : "DRAW";
    slot.appendChild(tag);
    wrap.appendChild(slot);
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setAuto(on) {
  autoOn = on;
  $("autoBtn").innerHTML = `<span class="btn-icon">◈</span> Auto: ${on ? "On" : "Off"}`;
  $("autoBtn").classList.toggle("primary", on);
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (on) {
    const s = loadSettings();
    const interval = Math.max(1500, s.autoIntervalMs || 3000);
    autoTimer = setInterval(doScan, interval);
    doScan();
  }
}

// ---- wiring ----
showView(loadSettings().gameMode);
$("scanBtn").addEventListener("click", doScan);
$("autoBtn").addEventListener("click", () => setAuto(!autoOn));
$("closeOverlay").addEventListener("click", () => win.close());

listen("trigger-scan", () => doScan());
listen("scan-progress", (e) => {
  if (typeof e.payload === "string") progressStep(e.payload);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") doScan();
});
