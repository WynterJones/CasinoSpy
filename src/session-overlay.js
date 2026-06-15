import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  getSession, startSession, stopSession, adjustCurrent, setCurrent,
  winLoss, money, wlState, onSessionChange, getSessionsHistory,
} from "./session.js";
import { createBuddyStage, loadBuddy } from "./buddy.js";

const $ = (id) => document.getElementById(id);
const win = getCurrentWindow();

const buddy = createBuddyStage($("sessBuddy"), { size: 220, reactMs: 2000 });

// History panel starts collapsed; expanding grows the window (capped) and the
// list scrolls inside it.
const WIN_W = 312;
const WIN_H_BASE = 480;
const WIN_H_OPEN = 680;
let histOpen = false;
function resizeWin() {
  const tall = histOpen && getSession().active;
  win.setSize(new LogicalSize(WIN_W, tall ? WIN_H_OPEN : WIN_H_BASE)).catch(() => {});
}
function setHist(open) {
  histOpen = open;
  $("oHist").hidden = !open;
  $("oHistToggle").classList.toggle("open", open);
  resizeWin();
}

// Mirror the primary character's flip on the session buddy.
function applyFlip() {
  $("sessBuddy").classList.toggle("flip", !!loadBuddy().flip);
}

function renderHist() {
  const wrap = $("oHist");
  if (!wrap) return;
  const h = getSessionsHistory();
  const toggle = $("oHistToggle");
  if (toggle) toggle.querySelector("span").textContent = h.length ? `Session history (${h.length})` : "Session history";
  if (!h.length) {
    wrap.innerHTML = `<div class="sh-empty">No locked-in sessions yet.</div>`;
    return;
  }
  wrap.innerHTML =
    `<ul class="sh-list">` +
    h.map((e) => {
      const s = wlState(e.result);
      return `<li class="sh-row"><span class="sh-buyin">${money(e.buyIn)} &rarr; ${money(e.final)}</span>` +
        `<span class="sh-res ${s.cls}">${s.cls === "even" ? "Even" : s.text}</span></li>`;
    }).join("") +
    `</ul>`;
}

function render() {
  const s = getSession();
  $("oIdle").hidden = s.active;
  $("oLive").hidden = !s.active;
  $("sessDot").style.color = s.active ? "#2ed178" : "#b8c8b7";
  renderHist();
  applyFlip();
  buddy.syncFromState();
  if (!s.active) { if (histOpen) setHist(false); return; }

  const wl = winLoss(s);
  const st = wlState(wl);
  const amt = $("oAmt");
  if (document.activeElement !== amt) amt.value = s.current.toFixed(2);
  const panel = $("oPanel");
  if (panel) panel.className = "sess-panel " + st.cls;
  const wlEl = $("oWL");
  wlEl.className = "sp-wl " + st.cls;
  wlEl.textContent = st.cls === "even" ? "Even · buy-in " + money(s.buyIn) : st.text + " on " + money(s.buyIn);
}

const step = () => Math.max(0.01, parseFloat($("oStep").value) || 5);
$("oStart").addEventListener("click", () => {
  const b = parseFloat($("oBuyIn").value);
  if (!Number.isFinite(b) || b < 0) { $("oBuyIn").focus(); return; }
  startSession(b);
  render();
});
$("oStop").addEventListener("click", () => { stopSession(); render(); });
$("oPlus").addEventListener("click", () => { adjustCurrent(step()); render(); });
$("oMinus").addEventListener("click", () => { adjustCurrent(-step()); render(); });
$("oAmt").addEventListener("change", () => { setCurrent($("oAmt").value); render(); });
$("oHistToggle").addEventListener("click", () => setHist(!histOpen));
$("closeSess").addEventListener("click", () => win.close());
onSessionChange(render);
render();
resizeWin();
