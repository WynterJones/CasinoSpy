// Pixel-art companions. Each character renders an animated sprite that loops an
// idle animation, occasionally plays a random "emote", and reacts to live events
// with a win/lose clip + a CSS pop:
//   - live session counter goes up   -> win
//   - live session counter goes down -> lose
//   - bankroll withdrawal added      -> win  (cashing out)
//   - bankroll deposit added         -> lose (topping up)
//
// Characters live in settings.companions.list (see settings.js). Frames are
// base64 data URIs stored inline. When a character has no frames we fall back to
// the default avatar image shown as a single static frame (the CSS pop still
// plays, so it still feels alive).

import { loadSettings, patchSettings } from "./settings.js";
import { getSession } from "./session.js";

export const DEFAULT_AVATAR = "/assets/jiffrey.png";

// ---------------- companions store ----------------
export function getCompanions() {
  return loadSettings().companions.list || [];
}
export function getApiKey() {
  return (loadSettings().companions.apiKey || "").trim();
}
export function setApiKey(key) {
  return patchSettings({ companions: { apiKey: (key || "").trim() } }).companions;
}
export function getPrimary() {
  const list = getCompanions();
  return list.length ? list[0] : null;
}
export function getCompanion(id) {
  return getCompanions().find((c) => c.id === id) || null;
}
function saveList(list) {
  return patchSettings({ companions: { list } }).companions.list;
}
export function newCompanionId() {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const CHAR_DEFAULTS = {
  name: "Buddy", description: "", characterId: null, base: null,
  idle: [], win: [], lose: [], emotes: [],
  flip: false, pos: null, size: 200, hidden: false, createdAt: 0,
};

export function addCompanion(obj) {
  const list = getCompanions().slice();
  const c = { ...CHAR_DEFAULTS, id: newCompanionId(), createdAt: Date.now(), ...obj };
  list.push(c);
  saveList(list);
  return c;
}
export function updateCompanion(id, patch) {
  const list = getCompanions().map((c) => (c.id === id ? { ...c, ...patch } : c));
  saveList(list);
  return list.find((c) => c.id === id) || null;
}
export function removeCompanion(id) {
  saveList(getCompanions().filter((c) => c.id !== id));
}
export function hasAnyCompanion() {
  return getCompanions().some((c) => Array.isArray(c.idle) && c.idle.length);
}

// ---------------- legacy / back-compat (operate on the primary) ----------------
export function loadBuddy() {
  const p = getPrimary();
  const apiKey = getApiKey();
  if (!p) return { ...CHAR_DEFAULTS, name: "Jeffry", apiKey };
  return { ...p, apiKey };
}
export function saveBuddy(patch) {
  if (patch && "apiKey" in patch) setApiKey(patch.apiKey);
  const rest = { ...(patch || {}) };
  delete rest.apiKey;
  if (Object.keys(rest).length) {
    const p = getPrimary();
    if (p) updateCompanion(p.id, rest);
  }
  return loadBuddy();
}
export function hasBuddy() {
  const p = getPrimary();
  return !!(p && Array.isArray(p.idle) && p.idle.length);
}
export function buddyName() {
  const p = getPrimary();
  const n = (p && (p.name || "").trim()) || "";
  return n || "Jeffry";
}

// Resolve frames for a clip on a given character, falling back to the base
// sprite or the default avatar so something always renders.
function framesFor(character, name) {
  if (character) {
    const arr = character[name];
    if (Array.isArray(arr) && arr.length) return arr;
    if (character.base) return [character.base];
  }
  return [DEFAULT_AVATAR];
}
function hasFrames(character) {
  return !!(character && Array.isArray(character.idle) && character.idle.length);
}

/**
 * Mount an animated companion into `container`. Pass `characterId` to bind a
 * specific character; otherwise it tracks the primary. Returns a controller:
 *   refresh()        re-read frames + restart idle (after setup/edit completes)
 *   react(type)      play 'win' | 'lose' once, then return to idle
 *   syncFromState()  diff session/ledger vs last seen and react if changed
 *   destroy()        stop timers
 */
export function createBuddyStage(container, { size = 96, reactMs = 2200, characterId = null } = {}) {
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
  let emoteTimer = null;

  function getChar() {
    return (characterId && getCompanion(characterId)) || getPrimary();
  }

  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function playFrames(fr, fps) {
    stopLoop();
    container.classList.toggle("pixel", hasFrames(getChar()));
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

  // Occasionally play a random emote while idling, then settle back to idle.
  function scheduleEmote() {
    if (emoteTimer) { clearTimeout(emoteTimer); emoteTimer = null; }
    const ch = getChar();
    const emotes = ((ch && ch.emotes) || []).filter((e) => Array.isArray(e) && e.length);
    if (!emotes.length) return;
    const wait = 10000 + Math.floor(Math.random() * 12000); // ~10–22s
    emoteTimer = setTimeout(() => {
      const clip = emotes[Math.floor(Math.random() * emotes.length)];
      playFrames(clip, 6);
      if (returnTimer) clearTimeout(returnTimer);
      returnTimer = setTimeout(playIdle, 1400);
    }, wait);
  }

  function playIdle() {
    container.classList.remove("react-win", "react-lose");
    playFrames(framesFor(getChar(), "idle"), 4);
    scheduleEmote();
  }

  function react(type) {
    if (type !== "win" && type !== "lose") return;
    if (emoteTimer) { clearTimeout(emoteTimer); emoteTimer = null; }
    container.classList.remove("react-win", "react-lose");
    // force reflow so the animation restarts even on repeat reactions
    void container.offsetWidth;
    container.classList.add(type === "win" ? "react-win" : "react-lose");
    playFrames(framesFor(getChar(), type), 6);
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
      if (snap.lastType === "withdrawal") react("win");
      else if (snap.lastType === "deposit") react("lose");
    } else if (last.active && snap.active && snap.current !== last.current) {
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
      if (emoteTimer) clearTimeout(emoteTimer);
      window.removeEventListener("storage", onStorage);
    },
  };
}
