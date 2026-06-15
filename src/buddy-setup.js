// Buddy setup wizard, rendered inside the in-app modal (#buddyModal):
//   api-key -> describe -> pick (3 options) -> animate (idle/win/lose) -> done.
// The finished companion is saved to settings.buddy as inline frame data URIs.

import {
  getBalance,
  createPixelImageOptions,
  createCharacter,
  pollJob,
  animateAndCollect,
  pixelLabErrorMessage,
} from "./pixellab.js";
import { loadBuddy, saveBuddy, hasBuddy, DEFAULT_AVATAR } from "./buddy.js";

// Clips we generate for every buddy. Order matters (idle first = fallback base).
const CLIPS = [
  { key: "idle", label: "Idle", action: "idle breathing, gentle sway", fps: 4 },
  { key: "win", label: "Win", action: "celebrating, cheering with both arms raised, happy", fps: 6 },
  { key: "lose", label: "Lose", action: "sad and disappointed, head down, slumped shoulders", fps: 6 },
];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function openBuddySetup(modalEl, onComplete) {
  const body = modalEl.querySelector("#bmBody");
  const titleEl = modalEl.querySelector("#bmTitle");

  const state = {
    step: "apikey",
    apiKey: loadBuddy().apiKey || "",
    name: loadBuddy().name || "Jeffry",
    description: loadBuddy().description || "",
    balance: null,
    options: [],
    selected: null,
    busy: false,
    error: null,
    progress: [], // [{ key, label, status }]
  };

  modalEl.hidden = false;
  // If a key already exists, jump straight to describe.
  state.step = state.apiKey ? "describe" : "apikey";
  render();

  function setError(msg) { state.error = msg; render(); }

  function errorBanner() {
    return state.error
      ? `<div class="bm-error" id="bmError">${esc(state.error)}</div>`
      : "";
  }

  function render() {
    if (titleEl) titleEl.textContent = state.step === "manage" || hasBuddy() ? "Your pixel buddy" : "Create your pixel buddy";
    if (state.step === "apikey") renderApiKey();
    else if (state.step === "describe") renderDescribe();
    else if (state.step === "pick") renderPick();
    else if (state.step === "animate") renderAnimate();
    else if (state.step === "done") renderDone();
  }

  // ---- step: api key ----
  function renderApiKey() {
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Paste your <b>PixelLab</b> API key to generate an animated pixel-art buddy. The key is stored locally on this device.</p>
      <input class="bm-input" id="bmKey" type="password" placeholder="PixelLab API key" value="${esc(state.apiKey)}" />
      <div class="bm-actions">
        <button class="primary" id="bmKeyGo" ${state.busy ? "disabled" : ""}>${state.busy ? "Checking…" : "Validate & continue"}</button>
        <a class="bm-link" href="https://api.pixellab.ai/v2/docs#description/authentication" target="_blank" rel="noreferrer">Get a key &rsaquo;</a>
      </div>`;
    const key = body.querySelector("#bmKey");
    key.addEventListener("input", (e) => { state.apiKey = e.target.value; });
    body.querySelector("#bmKeyGo").addEventListener("click", validateKey);
    key.addEventListener("keydown", (e) => { if (e.key === "Enter") validateKey(); });
  }

  async function validateKey() {
    if (!state.apiKey.trim() || state.busy) return;
    state.busy = true; state.error = null; render();
    try {
      state.balance = await getBalance(state.apiKey);
      saveBuddy({ apiKey: state.apiKey.trim() });
      state.busy = false; state.step = "describe"; render();
    } catch (e) {
      state.busy = false; setError(pixelLabErrorMessage(e));
    }
  }

  // ---- step: describe ----
  function renderDescribe() {
    const gens = state.balance && state.balance.generations !== undefined
      ? `<p class="bm-note">${state.balance.generations} generations remaining${state.balance.plan ? " · " + esc(state.balance.plan) : ""}</p>` : "";
    body.innerHTML = `
      ${errorBanner()}
      ${gens}
      <label class="bm-label">Name</label>
      <input class="bm-input" id="bmName" placeholder="Jeffry" value="${esc(state.name)}" />
      <label class="bm-label">Describe your buddy</label>
      <textarea class="bm-input bm-textarea" id="bmDesc" placeholder="a lucky golden cat in a tiny tuxedo holding a poker chip">${esc(state.description)}</textarea>
      <div class="bm-actions">
        <button class="primary" id="bmGen" ${state.busy ? "disabled" : ""}>Generate 3 options</button>
        <button class="bm-ghost" id="bmBackKey">Change key</button>
      </div>`;
    body.querySelector("#bmName").addEventListener("input", (e) => { state.name = e.target.value; });
    body.querySelector("#bmDesc").addEventListener("input", (e) => { state.description = e.target.value; });
    body.querySelector("#bmGen").addEventListener("click", generate);
    body.querySelector("#bmBackKey").addEventListener("click", () => { state.step = "apikey"; render(); });
  }

  async function generate() {
    if (!state.description.trim() || state.busy) return;
    state.busy = true; state.error = null; state.options = []; state.selected = null;
    state.step = "pick"; render();
    try {
      const imgs = await createPixelImageOptions(state.apiKey, {
        description: `pixel art character, ${state.description.trim()}`,
      });
      state.options = imgs; state.busy = false; render();
    } catch (e) {
      state.busy = false; state.step = "describe"; setError(pixelLabErrorMessage(e));
    }
  }

  // ---- step: pick ----
  function renderPick() {
    const tiles = state.busy && !state.options.length
      ? Array.from({ length: 3 }).map(() => `<div class="bm-opt loading"><span class="bm-spin"></span></div>`).join("")
      : state.options.map((img, i) => `
          <button class="bm-opt${state.selected === i ? " sel" : ""}" data-i="${i}">
            <img src="${img}" alt="Option ${i + 1}" />
          </button>`).join("");
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Pick your favourite, then we'll animate it.</p>
      <div class="bm-opts">${tiles}</div>
      <div class="bm-actions">
        <button class="primary" id="bmAnimate" ${state.busy || state.selected === null ? "disabled" : ""}>Animate (idle · win · lose)</button>
        <button class="bm-ghost" id="bmRegen" ${state.busy ? "disabled" : ""}>Regenerate</button>
      </div>`;
    body.querySelectorAll(".bm-opt[data-i]").forEach((el) =>
      el.addEventListener("click", () => { state.selected = parseInt(el.dataset.i, 10); render(); }));
    body.querySelector("#bmAnimate").addEventListener("click", animate);
    body.querySelector("#bmRegen").addEventListener("click", generate);
  }

  // ---- step: animate ----
  function renderAnimate() {
    const rows = state.progress.map((p) => {
      const ic = p.status === "done" ? "✓" : p.status === "error" ? "!" : p.status === "running" ? "" : "·";
      return `<li class="bm-prog ${p.status}"><span class="bm-prog-ic">${ic}</span>${esc(p.label)}</li>`;
    }).join("");
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Bringing <b>${esc(state.name.trim() || "Jeffry")}</b> to life…</p>
      <ul class="bm-prog-list">${rows}</ul>`;
  }

  async function animate() {
    if (state.selected === null || state.busy) return;
    const sprite = state.options[state.selected];
    state.busy = true; state.error = null; state.step = "animate";
    state.progress = CLIPS.map((c) => ({ key: c.key, label: c.label, status: "pending" }));
    render();
    try {
      // 1. Turn the chosen sprite into a reusable character.
      const job = await createCharacter(state.apiKey, {
        description: `pixel art character, ${state.description.trim()}`,
        referenceImage: sprite,
      });
      await pollJob(state.apiKey, job.jobId);
      const characterId = job.characterId;
      if (!characterId) throw new Error("PixelLab did not return a character id");

      // 2. Generate each clip sequentially (kinder on rate limits).
      const clips = {};
      for (const c of CLIPS) {
        setProgress(c.key, "running");
        try {
          const frames = await animateAndCollect(state.apiKey, { characterId, action: c.action });
          clips[c.key] = frames.length ? frames : [sprite];
          setProgress(c.key, "done");
        } catch {
          clips[c.key] = [sprite]; // fall back to the static sprite
          setProgress(c.key, "error");
        }
      }

      saveBuddy({
        name: state.name.trim() || "Jeffry",
        description: state.description.trim(),
        characterId,
        base: sprite,
        idle: clips.idle,
        win: clips.win,
        lose: clips.lose,
        createdAt: Date.now(),
      });
      state.busy = false; state.step = "done"; render();
      if (onComplete) onComplete();
    } catch (e) {
      state.busy = false; state.step = "pick"; setError(pixelLabErrorMessage(e));
    }
  }

  function setProgress(key, status) {
    state.progress = state.progress.map((p) => (p.key === key ? { ...p, status } : p));
    render();
  }

  // ---- step: done ----
  function renderDone() {
    const b = loadBuddy();
    body.innerHTML = `
      <div class="bm-done">
        <img class="bm-done-sprite" src="${b.idle && b.idle[0] ? b.idle[0] : DEFAULT_AVATAR}" alt="" />
        <p class="bm-lead"><b>${esc(b.name || "Jeffry")}</b> is ready! They'll cheer your wins and slump on losses, bottom-centre of the app and in your session window.</p>
      </div>
      <div class="bm-actions">
        <button class="primary" id="bmDoneClose">Done</button>
        <button class="bm-ghost" id="bmRemake">Make a new one</button>
      </div>`;
    body.querySelector("#bmDoneClose").addEventListener("click", () => close());
    body.querySelector("#bmRemake").addEventListener("click", () => { state.step = "describe"; state.options = []; state.selected = null; render(); });
  }

  function close() {
    modalEl.hidden = true;
    if (onComplete) onComplete();
  }

  // expose close for the modal scrim/✕ in main.js
  modalEl._closeBuddySetup = close;
}
