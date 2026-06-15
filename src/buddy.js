// The pixel-art companion ("Jeffry"). Renders an animated sprite that loops an
// idle animation and reacts to live events with a win/lose clip + a CSS pop:
//   - live session counter goes up   -> win
//   - live session counter goes down -> lose
//   - bankroll withdrawal added      -> win  (cashing out)
//   - bankroll deposit added         -> lose (topping up)
//
// Frames are stored as base64 data URIs in settings.buddy. When the user hasn't
// generated a buddy yet, we fall back to the default avatar image shown as a
// single static frame (the CSS pop still plays, so it still feels alive).

import { loadSettings, patchSettings } from "./settings.js";
import { getSession } from "./session.js";

export const DEFAULT_AVATAR = "/assets/jiffrey.png";

export function loadBuddy() {
  return loadSettings().buddy;
}
export function saveBuddy(patch) {
  const cur = loadSettings().buddy;
  return patchSettings({ buddy: { ...cur, ...patch } }).buddy;
}
export function hasBuddy() {
  const b = loadBuddy();
  return Array.isArray(b.idle) && b.idle.length > 0;
}
export function buddyName() {
  const n = (loadBuddy().name || "").trim();
  return n || "Jeffry";
}

// Resolve the frames for a given clip, falling back to the base sprite or the
// default avatar so something always renders.
function framesFor(name) {
  const b = loadBuddy();
  const arr = b[name];
  if (Array.isArray(arr) && arr.length) return arr;
  if (b.base) return [b.base];
  return [DEFAULT_AVATAR];
}

/**
 * Mount an animated buddy into `container`. Returns a controller:
 *   refresh()        re-read frames + restart idle (after setup completes)
 *   react(type)      play 'win' | 'lose' once, then return to idle
 *   syncFromState()  diff session/ledger vs last seen and react if changed
 *   destroy()        stop timers
 */
export function createBuddyStage(container, { size = 96, reactMs = 2200 } = {}) {
  container.classList.add("buddy-stage");
  const img = document.createElement("img");
  img.className = "buddy-sprite";
  img.alt = "";
  img.decoding = "async";
  img.style.width = size + "px";
  img.style.height = size + "px";
  container.appendChild(img);

  let frames = [];
  let idx = 0;
  let timer = null;
  let returnTimer = null;

  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function playFrames(fr, fps) {
    stopLoop();
    container.classList.toggle("pixel", hasBuddy());
    frames = fr && fr.length ? fr : [];
    idx = 0;
    if (!frames.length) { img.removeAttribute("src"); return; }
    img.src = frames[0];
    if (frames.length === 1) return;
    timer = setInterval(() => {
      idx = (idx + 1) % frames.length;
      img.src = frames[idx];
    }, Math.max(80, Math.round(1000 / (fps || 4))));
  }

  function playIdle() {
    container.classList.remove("react-win", "react-lose");
    playFrames(framesFor("idle"), 4);
  }

  function react(type) {
    if (type !== "win" && type !== "lose") return;
    container.classList.remove("react-win", "react-lose");
    // force reflow so the animation restarts even on repeat reactions
    void container.offsetWidth;
    container.classList.add(type === "win" ? "react-win" : "react-lose");
    playFrames(framesFor(type), 6);
    if (returnTimer) clearTimeout(returnTimer);
    returnTimer = setTimeout(playIdle, reactMs);
  }

  // ---- event diffing ----
  function snapshot() {
    const s = getSession();
    const led = loadSettings().ledger || [];
    return {
      current: s.current,
      active: s.active,
      ledgerLen: led.length,
      lastType: led.length ? led[led.length - 1].type : null,
    };
  }
  let last = snapshot();

  function syncFromState() {
    const snap = snapshot();
    if (snap.ledgerLen > last.ledgerLen) {
      // A new bankroll entry was added.
      if (snap.lastType === "withdrawal") react("win");
      else if (snap.lastType === "deposit") react("lose");
    } else if (last.active && snap.active && snap.current !== last.current) {
      // Genuine in-session adjustment (ignore start/stop transitions).
      react(snap.current > last.current ? "win" : "lose");
    }
    last = snap;
  }

  const onStorage = () => syncFromState();
  window.addEventListener("storage", onStorage);

  playIdle();

  return {
    refresh() { last = snapshot(); playIdle(); },
    react,
    syncFromState,
    destroy() {
      stopLoop();
      if (returnTimer) clearTimeout(returnTimer);
      window.removeEventListener("storage", onStorage);
    },
  };
}
