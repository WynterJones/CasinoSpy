import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getSession, startSession, stopSession, adjustCurrent, setCurrent,
  winLoss, money, wlState, onSessionChange,
} from "./session.js";

const $ = (id) => document.getElementById(id);
const win = getCurrentWindow();

function render() {
  const s = getSession();
  $("oIdle").hidden = s.active;
  $("oLive").hidden = !s.active;
  $("sessDot").style.color = s.active ? "#2ed178" : "#b8c8b7";
  if (!s.active) return;

  const wl = winLoss(s);
  const st = wlState(wl);
  const amt = $("oAmt");
  if (document.activeElement !== amt) amt.value = s.current.toFixed(2);
  const wlEl = $("oWL");
  wlEl.className = "counter-wl " + st.cls;
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
