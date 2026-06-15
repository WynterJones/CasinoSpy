import { invoke } from "@tauri-apps/api/core";
import { loadSettings, patchSettings } from "./settings.js";
import { parseBlackjack, parseVideoPoker } from "./scan.js";
import { bestMove } from "./strategy.js";
import { bestHold, parseCard, cardLabel } from "./videopoker.js";

const $ = (id) => document.getElementById(id);
const MODEL = "opus"; // always use Opus via the local Claude Code CLI

function applyToForm(s) {
  $("decks").value = String(s.rules.decks);
  $("h17").checked = !!s.rules.h17;
  $("das").checked = !!s.rules.das;
  $("surrender").checked = !!s.rules.surrender;
  $("vpPaytable").value = s.vpPaytable;
  renderRegion(s.region);
  applyMode(s.gameMode);
}

function applyMode(mode) {
  for (const tile of document.querySelectorAll(".mode-tile")) {
    tile.classList.toggle("selected", tile.dataset.mode === mode);
  }
  $("bjRules").hidden = mode !== "blackjack";
  $("vpRules").hidden = mode !== "videopoker";
}

function readForm() {
  const decksVal = $("decks").value;
  return {
    vpPaytable: $("vpPaytable").value,
    rules: {
      decks: decksVal === "unlimited" ? "unlimited" : parseInt(decksVal, 10),
      h17: $("h17").checked,
      das: $("das").checked,
      surrender: $("surrender").checked,
    },
  };
}

function renderRegion(region) {
  const el = $("regionStatus");
  if (!el) return;
  el.textContent = region ? "✓" : "✗";
  el.classList.toggle("set", !!region);
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

function persist() {
  return patchSettings(readForm());
}

// ---- wiring ----
let settings = loadSettings();
applyToForm(settings);

for (const id of ["decks", "h17", "das", "surrender", "vpPaytable"]) {
  $(id).addEventListener("change", () => {
    settings = persist();
  });
}

for (const tile of document.querySelectorAll(".mode-tile")) {
  tile.addEventListener("click", () => {
    settings = patchSettings({ gameMode: tile.dataset.mode });
    applyMode(settings.gameMode);
  });
}

$("pickRegion").addEventListener("click", async () => {
  settings = persist();
  try {
    await invoke("open_selector");
    setStatus("Drag a box around the hand…");
  } catch (e) {
    setStatus("Could not open selector: " + e, "err");
  }
});

$("launchOverlay").addEventListener("click", async () => {
  settings = persist();
  if (!settings.region) {
    setStatus("Pick a capture region first.", "err");
    return;
  }
  try {
    await invoke("open_overlay");
    setStatus("Overlay launched. Use Scan or the global hotkey.", "ok");
  } catch (e) {
    setStatus("Could not open overlay: " + e, "err");
  }
});

// ---- bankroll tracker ----
const money = (n) => "$" + Math.abs(n).toFixed(2);

function renderLedger() {
  const list = $("ledgerList");
  const led = settings.ledger || [];
  list.innerHTML = "";
  if (!led.length) {
    list.innerHTML = `<li class="led-empty">No entries yet — add a deposit or withdrawal.</li>`;
  }
  led.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "led-item " + e.type;
    const sign = e.type === "deposit" ? "+" : "−";
    li.innerHTML = `
      <span class="led-type">${e.type === "deposit" ? "Deposit" : "Withdraw"}</span>
      <span class="led-amt">${sign}${money(e.amount)}</span>
      <button class="led-del" data-i="${i}" title="Remove">✕</button>`;
    list.appendChild(li);
  });

  const dep = led.filter((e) => e.type === "deposit").reduce((s, e) => s + e.amount, 0);
  const wd = led.filter((e) => e.type === "withdrawal").reduce((s, e) => s + e.amount, 0);
  const net = wd - dep; // money out minus money in = profit/loss
  $("totDep").textContent = money(dep);
  $("totWd").textContent = money(wd);

  let cls, arrow, val;
  if (Math.abs(net) < 0.005) { cls = "even"; arrow = "＝"; val = "Even"; }
  else if (net > 0) { cls = "up"; arrow = "▲"; val = "+" + money(net); }
  else { cls = "down"; arrow = "▼"; val = "−" + money(net); }

  const netEl = $("totNet");
  netEl.textContent = cls === "even" ? "Even" : val + (cls === "up" ? " up" : " down");
  netEl.className = cls;

  const chip = $("netChip");
  chip.textContent = val;
  chip.className = "bk-net-chip " + cls;

  const badge = $("bankBadge");
  if (badge) {
    badge.className = "bank-badge " + cls;
    badge.querySelector(".bb-arrow").textContent = arrow;
    badge.querySelector(".bb-val").textContent = val;
  }
}

function addLedger(type) {
  const input = $("bkAmount");
  const amt = parseFloat(input.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    input.focus();
    return;
  }
  settings = patchSettings({ ledger: [...(settings.ledger || []), { type, amount: Math.round(amt * 100) / 100 }] });
  input.value = "";
  renderLedger();
}

$("addDeposit").addEventListener("click", () => addLedger("deposit"));
$("addWithdraw").addEventListener("click", () => addLedger("withdrawal"));
$("bkAmount").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addLedger("deposit");
});
$("ledgerList").addEventListener("click", (e) => {
  const btn = e.target.closest(".led-del");
  if (!btn) return;
  const i = parseInt(btn.dataset.i, 10);
  const led = [...(settings.ledger || [])];
  led.splice(i, 1);
  settings = patchSettings({ ledger: led });
  renderLedger();
});
renderLedger();

// Refresh region readout when the selector saves it.
window.addEventListener("storage", () => {
  settings = loadSettings();
  renderRegion(settings.region);
});
setInterval(() => {
  const s = loadSettings();
  if (JSON.stringify(s.region) !== JSON.stringify(settings.region)) {
    settings = s;
    renderRegion(settings.region);
    setStatus("Region updated.", "ok");
  }
}, 800);
