import { invoke } from "@tauri-apps/api/core";
import { loadSettings, patchSettings } from "./settings.js";
import {
  getSession, startSession, stopSession, adjustCurrent, setCurrent,
  winLoss, money, wlState, onSessionChange, getSessionsHistory, deleteSessionAt,
} from "./session.js";

const $ = (id) => document.getElementById(id);
let settings = loadSettings();

// ---- form: mode + rules ----
function applyMode(mode) {
  for (const t of document.querySelectorAll(".mode-tile")) t.classList.toggle("selected", t.dataset.mode === mode);
  $("bjRules").hidden = mode !== "blackjack";
  $("vpRules").hidden = mode !== "videopoker";
}
function applyToForm(s) {
  $("decks").value = String(s.rules.decks);
  $("h17").checked = !!s.rules.h17;
  $("das").checked = !!s.rules.das;
  $("surrender").checked = !!s.rules.surrender;
  $("vpPaytable").value = s.vpPaytable;
  applyMode(s.gameMode);
  renderRegion(s.region);
}
function readForm() {
  const decksVal = $("decks").value;
  return {
    vpPaytable: $("vpPaytable").value,
    rules: {
      decks: decksVal === "unlimited" ? "unlimited" : parseInt(decksVal, 10),
      h17: $("h17").checked, das: $("das").checked, surrender: $("surrender").checked,
    },
  };
}
function persist() { settings = patchSettings(readForm()); return settings; }

function setStatus() { /* status line removed from the tab bar */ }

function setBadge(id, val, cls) {
  const b = $(id);
  if (!b) return;
  b.className = "bank-badge " + cls;
  b.querySelector(".bb-val").textContent = val;
}
function renderRegion(region) {
  $("tabRegion").classList.toggle("has-region", !!region);
}

for (const id of ["decks", "h17", "das", "surrender", "vpPaytable"]) {
  $(id).addEventListener("change", persist);
}
for (const tile of document.querySelectorAll(".mode-tile")) {
  tile.addEventListener("click", () => { settings = patchSettings({ gameMode: tile.dataset.mode }); applyMode(settings.gameMode); });
}

// ---- tab bar ----
async function tab(cmd, msg) {
  try { await invoke(cmd); if (msg) setStatus(msg, "ok"); }
  catch (e) { setStatus("Error: " + e, "err"); }
}
$("tabRegion").addEventListener("click", () => { persist(); tab("open_selector", "Drag a box around the hand…"); });
$("tabOverlay").addEventListener("click", () => { persist(); tab("open_overlay", "Strategy overlay opened."); });
$("tabSession").addEventListener("click", () => tab("open_session_overlay", "Session counter opened."));
$("tabSlots").addEventListener("click", () => tab("open_slots_data", "Opening OLG Slots Data…"));
$("tabJiffrey").addEventListener("click", () => tab("open_jiffrey", "Jiffrey is here."));
$("openJiffrey").addEventListener("click", () => tab("open_jiffrey", "Jiffrey is here."));

// ---- live session ----
function renderSession() {
  const s = getSession();
  $("sessIdle").hidden = s.active;
  $("sessLive").hidden = !s.active;

  const st = wlState(winLoss(s));

  setBadge("sessBadge", s.active ? (st.cls === "even" ? "Even" : st.text) : "Off", s.active ? st.cls : "even");

  const chip = $("sessChip");
  chip.textContent = s.active ? (st.cls === "even" ? "Even" : st.text) : "Off";
  chip.className = "bk-net-chip " + (s.active ? st.cls : "even");

  if (s.active) {
    const amt = $("sessAmt");
    if (document.activeElement !== amt) amt.value = s.current.toFixed(2);
    const wlEl = $("sessWL");
    wlEl.className = "counter-wl " + st.cls;
    wlEl.textContent = st.cls === "even" ? "Even · buy-in " + money(s.buyIn) : st.text + " on " + money(s.buyIn);
  }
  renderSessHistory();
}

function renderSessHistory() {
  const wrap = $("sessHist");
  if (!wrap) return;
  const h = getSessionsHistory();
  if (!h.length) {
    wrap.innerHTML = `<h4>Session history</h4><div class="sh-empty">No locked-in sessions yet.</div>`;
    return;
  }
  const net = h.reduce((a, e) => a + e.result, 0);
  const tot = wlState(net);
  wrap.innerHTML =
    `<h4>Session history</h4><ul class="sess-hist-list">` +
    h.map((e, i) => {
      const s = wlState(e.result);
      return `<li class="sh-item"><span class="sh-buyin">${money(e.buyIn)} &rarr; ${money(e.final)}</span>` +
        `<span class="sh-res ${s.cls}">${s.cls === "even" ? "Even" : s.text}</span>` +
        `<button class="led-del" data-i="${i}" title="Remove">&times;</button></li>`;
    }).join("") +
    `</ul><div class="sess-hist-total"><span>Across ${h.length} session${h.length > 1 ? "s" : ""}</span><b class="${tot.cls}">${tot.cls === "even" ? "Even" : tot.text}</b></div>`;
}

$("startSession").addEventListener("click", () => {
  const buyIn = parseFloat($("buyIn").value);
  if (!Number.isFinite(buyIn) || buyIn < 0) { $("buyIn").focus(); return; }
  startSession(buyIn);
  renderSession();
});
$("stopSession").addEventListener("click", () => { stopSession(); renderSession(); });
const step = () => Math.max(0.01, parseFloat($("sessStep").value) || 5);
$("sessPlus").addEventListener("click", () => { adjustCurrent(step()); renderSession(); });
$("sessMinus").addEventListener("click", () => { adjustCurrent(-step()); renderSession(); });
$("sessAmt").addEventListener("change", () => { setCurrent($("sessAmt").value); renderSession(); });
$("sessHist").addEventListener("click", (e) => {
  const btn = e.target.closest(".led-del");
  if (!btn) return;
  deleteSessionAt(parseInt(btn.dataset.i, 10));
  renderSessHistory();
});
onSessionChange(() => renderSession());

// ---- bankroll ledger ----
function renderLedger() {
  const list = $("ledgerList");
  const led = (settings.ledger = loadSettings().ledger) || [];
  list.innerHTML = led.length ? "" : `<li class="led-empty">No entries yet — add a deposit or withdrawal.</li>`;
  led.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "led-item " + e.type;
    li.innerHTML = `<span class="led-type">${e.type === "deposit" ? "Deposit" : "Withdraw"}</span>
      <span class="led-amt">${e.type === "deposit" ? "+" : "−"}${money(e.amount)}</span>
      <button class="led-del" data-i="${i}" title="Remove">&times;</button>`;
    list.appendChild(li);
  });
  const deps = led.filter((e) => e.type === "deposit");
  const wds = led.filter((e) => e.type === "withdrawal");
  const dep = deps.reduce((s, e) => s + e.amount, 0);
  const wd = wds.reduce((s, e) => s + e.amount, 0);
  const net = wd - dep;
  $("totDep").textContent = money(dep);
  $("totWd").textContent = money(wd);
  const st = wlState(net);
  const netEl = $("totNet");
  netEl.textContent = st.cls === "even" ? "Even" : st.text;
  netEl.className = st.cls;
  const chip = $("netChip");
  chip.textContent = st.cls === "even" ? "Even" : st.text;
  chip.className = "bk-net-chip " + st.cls;
  const meta = $("bankMeta");
  if (meta) meta.textContent = `In ${money(dep)} (${deps.length}) · Out ${money(wd)} (${wds.length})`;
  setBadge("bankBadge", st.cls === "even" ? "Even" : st.text, st.cls);
}
function addLedger(type) {
  const input = $("bkAmount");
  const amt = parseFloat(input.value);
  if (!Number.isFinite(amt) || amt <= 0) { input.focus(); return; }
  settings = patchSettings({ ledger: [...(loadSettings().ledger || []), { type, amount: Math.round(amt * 100) / 100 }] });
  input.value = "";
  renderLedger();
}
$("addDeposit").addEventListener("click", () => addLedger("deposit"));
$("addWithdraw").addEventListener("click", () => addLedger("withdrawal"));
$("bkAmount").addEventListener("keydown", (e) => { if (e.key === "Enter") addLedger("deposit"); });
$("ledgerList").addEventListener("click", (e) => {
  const btn = e.target.closest(".led-del");
  if (!btn) return;
  const led = [...(loadSettings().ledger || [])];
  led.splice(parseInt(btn.dataset.i, 10), 1);
  settings = patchSettings({ ledger: led });
  renderLedger();
});

// ---- init ----
applyToForm(settings);
renderSession();
renderLedger();
setInterval(() => {
  const s = loadSettings();
  if (JSON.stringify(s.region) !== JSON.stringify(settings.region)) {
    settings.region = s.region;
    renderRegion(settings.region);
    setStatus("Region updated.", "ok");
  }
}, 800);
