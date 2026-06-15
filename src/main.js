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
