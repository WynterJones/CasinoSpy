import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getSession, startSession, stopSession, adjustCurrent, setCurrent,
  winLoss, money, wlState, onSessionChange, getSessionsHistory,
} from "./session.js";
import { createBuddyStage } from "./buddy.js";

const $ = (id) => document.getElementById(id);
const win = getCurrentWindow();

const buddy = createBuddyStage($("sessBuddy"), { size: 150, reactMs: 2000 });

function renderHist() {
  const wrap = $("oHist");
  if (!wrap) return;
  const h = getSessionsHistory().slice(0, 4);
  if (!h.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML =
    `<div class="sh-title">Recent sessions</div><ul class="sh-list">` +
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
  buddy.syncFromState();
  if (!s.active) return;

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
$("closeSess").addEventListener("click", () => win.close());
onSessionChange(render);
render();
