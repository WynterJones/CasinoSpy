// Companion manager + wizard, rendered inside the in-app modal (#buddyModal).
//
// Screens: apikey → manage (list of characters) → describe → pick → clips →
// animate → done, plus an "edit" screen for an existing character (rename, flip,
// regenerate selected clips using its stored PixelLab characterId, or regenerate
// its whole appearance). Finished characters are saved to settings.companions.

import {
  getBalance,
  createPixelImageOptions,
  createCharacter,
  pollJob,
  animateAndCollect,
  pixelLabErrorMessage,
} from "./pixellab.js";
import {
  getApiKey, setApiKey, getCompanions, getCompanion,
  addCompanion, updateCompanion, removeCompanion, hasAnyCompanion, DEFAULT_AVATAR,
} from "./buddy.js";

// Clips we can generate. Idle first (it's the fallback base). Emotes are the two
// random interlude animations; everything but idle is optional.
const CLIP_DEFS = [
  { key: "idle", label: "Idle", action: "idle breathing, gentle sway", required: true },
  { key: "win", label: "Win", action: "celebrating, cheering with both arms raised, happy" },
  { key: "lose", label: "Lose", action: "sad and disappointed, head down, slumped shoulders" },
  { key: "emote0", label: "Emote 1", action: "waving hello cheerfully", emoteIndex: 0 },
  { key: "emote1", label: "Emote 2", action: "doing a little happy dance, spinning", emoteIndex: 1 },
];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function charThumb(c) {
  return (c.idle && c.idle[0]) || c.base || DEFAULT_AVATAR;
}

export function openBuddySetup(modalEl, onComplete, opts = {}) {
  const body = modalEl.querySelector("#bmBody");
  const titleEl = modalEl.querySelector("#bmTitle");

  const state = {
    step: "apikey",
    apiKey: getApiKey(),
    balance: null,
    busy: false,
    error: null,
    // wizard scratch
    mode: "add", // "add" | "regen" (regenerate appearance of editId)
    editId: null, // character being edited / regenerated
    name: "Buddy",
    description: "",
    imgCount: 3,
    options: [],
    selected: null,
    clips: { idle: true, win: true, lose: true, emote0: false, emote1: false },
    progress: [],
  };

  modalEl.hidden = false;
  if (opts.editId && getCompanion(opts.editId)) {
    state.step = "edit"; state.editId = opts.editId;
  } else if (!state.apiKey) {
    state.step = "apikey";
  } else {
    state.step = "manage";
  }
  render();

  function setError(msg) { state.error = msg; render(); }
  function errorBanner() {
    return state.error ? `<div class="bm-error" id="bmError">${esc(state.error)}</div>` : "";
  }

  function render() {
    if (titleEl) titleEl.textContent =
      state.step === "edit" ? "Edit character"
      : state.step === "manage" ? "Your characters"
      : hasAnyCompanion() ? "Add a character" : "Create your first character";
    if (state.step === "apikey") renderApiKey();
    else if (state.step === "manage") renderManage();
    else if (state.step === "describe") renderDescribe();
    else if (state.step === "pick") renderPick();
    else if (state.step === "clips") renderClips();
    else if (state.step === "animate") renderAnimate();
    else if (state.step === "edit") renderEdit();
    else if (state.step === "done") renderDone();
  }

  // ---- step: api key ----
  function renderApiKey() {
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Paste your <b>PixelLab</b> API key to generate animated pixel-art characters. The key is stored locally on this device.</p>
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
      setApiKey(state.apiKey);
      state.busy = false; state.step = hasAnyCompanion() ? "manage" : "describe"; render();
    } catch (e) {
      state.busy = false; setError(pixelLabErrorMessage(e));
    }
  }

  // ---- step: manage (list of characters) ----
  function renderManage() {
    const list = getCompanions();
    const tiles = list.map((c) => `
      <div class="bm-char" data-id="${c.id}">
        <img class="bm-char-img" src="${esc(charThumb(c))}" alt="" />
        <span class="bm-char-name">${esc(c.name || "Buddy")}</span>
        <div class="bm-char-actions">
          <button class="bm-ghost bm-char-edit" data-id="${c.id}">Edit</button>
          <button class="bm-ghost bm-char-del" data-id="${c.id}">Delete</button>
        </div>
      </div>`).join("");
    body.innerHTML = `
      ${errorBanner()}
      ${list.length ? `<div class="bm-chars">${tiles}</div>` : `<p class="bm-lead">No characters yet — add your first one.</p>`}
      <div class="bm-actions">
        <button class="primary" id="bmAddNew">+ Add character</button>
        <button class="bm-ghost" id="bmChangeKey">Change API key</button>
      </div>`;
    body.querySelector("#bmAddNew").addEventListener("click", startAdd);
    body.querySelector("#bmChangeKey").addEventListener("click", () => { state.step = "apikey"; render(); });
    body.querySelectorAll(".bm-char-edit").forEach((el) =>
      el.addEventListener("click", () => { state.editId = el.dataset.id; state.step = "edit"; render(); }));
    body.querySelectorAll(".bm-char-del").forEach((el) =>
      el.addEventListener("click", () => {
        const c = getCompanion(el.dataset.id);
        if (!c) return;
        if (el.dataset.armed) { removeCompanion(el.dataset.id); finishChange(); render(); return; }
        el.dataset.armed = "1"; el.textContent = "Confirm?"; el.classList.add("danger");
      }));
  }

  function startAdd() {
    state.mode = "add"; state.editId = null;
    state.name = "Buddy"; state.description = ""; state.imgCount = 3;
    state.options = []; state.selected = null;
    state.clips = { idle: true, win: true, lose: true, emote0: false, emote1: false };
    state.error = null; state.step = "describe"; render();
  }

  // ---- step: describe ----
  function renderDescribe() {
    const gens = state.balance && state.balance.generations !== undefined
      ? `<p class="bm-note">${state.balance.generations} generations remaining${state.balance.plan ? " · " + esc(state.balance.plan) : ""}</p>` : "";
    const counts = [1, 2, 3].map((n) =>
      `<button type="button" class="bm-count-opt${state.imgCount === n ? " active" : ""}" data-n="${n}">${n}</button>`).join("");
    body.innerHTML = `
      ${errorBanner()}
      ${gens}
      <label class="bm-label">Name</label>
      <input class="bm-input" id="bmName" placeholder="Buddy" value="${esc(state.name)}" />
      <label class="bm-label">Describe your character (pet, person, object…)</label>
      <textarea class="bm-input bm-textarea" id="bmDesc" placeholder="a lucky golden cat in a tiny tuxedo holding a poker chip">${esc(state.description)}</textarea>
      <label class="bm-label">Starter images to generate</label>
      <div class="bm-count" id="bmCount">${counts}</div>
      <div class="bm-actions">
        <button class="primary" id="bmGen" ${state.busy ? "disabled" : ""}>Generate ${state.imgCount} option${state.imgCount > 1 ? "s" : ""}</button>
        <button class="bm-ghost" id="bmBackManage">Back</button>
      </div>`;
    body.querySelector("#bmName").addEventListener("input", (e) => { state.name = e.target.value; });
    body.querySelector("#bmDesc").addEventListener("input", (e) => { state.description = e.target.value; });
    body.querySelectorAll(".bm-count-opt").forEach((el) =>
      el.addEventListener("click", () => { state.imgCount = parseInt(el.dataset.n, 10); render(); }));
    body.querySelector("#bmGen").addEventListener("click", generate);
    body.querySelector("#bmBackManage").addEventListener("click", () => { state.step = hasAnyCompanion() ? "manage" : "apikey"; render(); });
  }

  async function generate() {
    if (!state.description.trim() || state.busy) return;
    state.busy = true; state.error = null; state.options = []; state.selected = null;
    state.step = "pick"; render();
    try {
      const imgs = await createPixelImageOptions(
        getApiKey(),
        { description: `pixel art character, ${state.description.trim()}` },
        state.imgCount
      );
      state.options = imgs; state.busy = false; render();
    } catch (e) {
      state.busy = false; state.step = "describe"; setError(pixelLabErrorMessage(e));
    }
  }

  // ---- step: pick ----
  function renderPick() {
    const tiles = state.busy && !state.options.length
      ? Array.from({ length: state.imgCount }).map(() => `<div class="bm-opt loading"><span class="bm-spin"></span></div>`).join("")
      : state.options.map((img, i) => `
          <button class="bm-opt${state.selected === i ? " sel" : ""}" data-i="${i}">
            <img src="${img}" alt="Option ${i + 1}" />
          </button>`).join("");
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Pick your favourite, then choose what to animate.</p>
      <div class="bm-opts">${tiles}</div>
      <div class="bm-actions">
        <button class="primary" id="bmToClips" ${state.busy || state.selected === null ? "disabled" : ""}>Choose animations</button>
        <button class="bm-ghost" id="bmRegen" ${state.busy ? "disabled" : ""}>Regenerate</button>
      </div>`;
    body.querySelectorAll(".bm-opt[data-i]").forEach((el) =>
      el.addEventListener("click", () => { state.selected = parseInt(el.dataset.i, 10); render(); }));
    body.querySelector("#bmToClips").addEventListener("click", () => { state.step = "clips"; render(); });
    body.querySelector("#bmRegen").addEventListener("click", generate);
  }

  // ---- step: clips (which animations to generate) ----
  function renderClips() {
    const rows = CLIP_DEFS.map((c) => `
      <label class="bm-clip${c.required ? " req" : ""}">
        <input type="checkbox" data-key="${c.key}" ${state.clips[c.key] ? "checked" : ""} ${c.required ? "checked disabled" : ""} />
        <span>${esc(c.label)}${c.required ? " (always)" : ""}</span>
      </label>`).join("");
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Each animation is generated separately. Idle is required; emotes play at random while idling.</p>
      <div class="bm-clips">${rows}</div>
      <div class="bm-actions">
        <button class="primary" id="bmAnimate">Generate animations</button>
        <button class="bm-ghost" id="bmBackPick">Back</button>
      </div>`;
    body.querySelectorAll(".bm-clip input[data-key]").forEach((el) =>
      el.addEventListener("change", () => { state.clips[el.dataset.key] = el.checked; }));
    body.querySelector("#bmAnimate").addEventListener("click", animateNew);
    body.querySelector("#bmBackPick").addEventListener("click", () => { state.step = "pick"; render(); });
  }

  function selectedClipKeys() {
    return CLIP_DEFS.filter((c) => c.required || state.clips[c.key]).map((c) => c.key);
  }

  // ---- step: animate (progress) ----
  function renderAnimate() {
    const rows = state.progress.map((p) => {
      const ic = p.status === "done" ? "✓" : p.status === "error" ? "!" : p.status === "running" ? "" : "·";
      return `<li class="bm-prog ${p.status}"><span class="bm-prog-ic">${ic}</span>${esc(p.label)}</li>`;
    }).join("");
    body.innerHTML = `
      ${errorBanner()}
      <p class="bm-lead">Bringing <b>${esc(state.name.trim() || "Buddy")}</b> to life…</p>
      <ul class="bm-prog-list">${rows}</ul>`;
  }
  function setProgress(key, status) {
    state.progress = state.progress.map((p) => (p.key === key ? { ...p, status } : p));
    render();
  }

  // Generate the selected clips for a known characterId. Returns
  // { result: {idle,win,lose}, emotes: [clip|null, clip|null] }.
  async function runClips(characterId, baseSprite, keys) {
    const result = {};
    const emotes = [null, null];
    for (const c of CLIP_DEFS) {
      if (!keys.includes(c.key)) continue;
      setProgress(c.key, "running");
      try {
        const frames = await animateAndCollect(getApiKey(), { characterId, action: c.action });
        const fr = frames.length ? frames : [baseSprite];
        if (c.emoteIndex !== undefined) emotes[c.emoteIndex] = fr; else result[c.key] = fr;
        setProgress(c.key, "done");
      } catch {
        const fb = [baseSprite];
        if (c.emoteIndex !== undefined) emotes[c.emoteIndex] = fb; else result[c.key] = fb;
        setProgress(c.key, "error");
      }
    }
    return { result, emotes };
  }

  // Add new character (or regenerate an existing character's appearance).
  async function animateNew() {
    if (state.selected === null || state.busy) return;
    const sprite = state.options[state.selected];
    const keys = selectedClipKeys();
    state.busy = true; state.error = null; state.step = "animate";
    state.progress = CLIP_DEFS.filter((c) => keys.includes(c.key)).map((c) => ({ key: c.key, label: c.label, status: "pending" }));
    render();
    try {
      const job = await createCharacter(getApiKey(), {
        description: `pixel art character, ${state.description.trim()}`,
        referenceImage: sprite,
      });
      await pollJob(getApiKey(), job.jobId);
      const characterId = job.characterId;
      if (!characterId) throw new Error("PixelLab did not return a character id");

      const { result, emotes } = await runClips(characterId, sprite, keys);
      const patch = {
        name: state.name.trim() || "Buddy",
        description: state.description.trim(),
        characterId,
        base: sprite,
        idle: result.idle || [sprite],
        win: result.win || [],
        lose: result.lose || [],
        emotes: [emotes[0] || [], emotes[1] || []],
      };
      if (state.mode === "regen" && state.editId) updateCompanion(state.editId, patch);
      else addCompanion(patch);

      state.busy = false; state.step = "done"; render();
      finishChange();
    } catch (e) {
      state.busy = false; state.step = state.mode === "regen" ? "edit" : "pick"; setError(pixelLabErrorMessage(e));
    }
  }

  // ---- step: edit existing character ----
  function renderEdit() {
    const c = getCompanion(state.editId);
    if (!c) { state.step = "manage"; render(); return; }
    const hasChar = !!c.characterId;
    const has = (key) => {
      if (key === "emote0") return !!(c.emotes && c.emotes[0] && c.emotes[0].length);
      if (key === "emote1") return !!(c.emotes && c.emotes[1] && c.emotes[1].length);
      return Array.isArray(c[key]) && c[key].length;
    };
    const rows = CLIP_DEFS.map((cd) => `
      <label class="bm-clip">
        <input type="checkbox" data-key="${cd.key}" />
        <span>${esc(cd.label)} <small>${has(cd.key) ? "· has it" : "· none"}</small></span>
      </label>`).join("");
    body.innerHTML = `
      ${errorBanner()}
      <div class="bm-edit-head">
        <img class="bm-char-img" src="${esc(charThumb(c))}" alt="" />
        <div class="bm-edit-fields">
          <label class="bm-label">Name</label>
          <input class="bm-input" id="bmEditName" value="${esc(c.name || "")}" />
          <label class="bm-flip-row"><input type="checkbox" id="bmEditFlip" ${c.flip ? "checked" : ""} /> Flip horizontally (face the other way)</label>
        </div>
      </div>
      <label class="bm-label">Regenerate animations${hasChar ? "" : " (needs a fresh appearance first)"}</label>
      <div class="bm-clips">${rows}</div>
      <div class="bm-actions">
        <button class="primary" id="bmRegenClips" ${hasChar ? "" : "disabled"}>Regenerate selected</button>
        <button class="bm-ghost" id="bmRegenLook">Regenerate appearance</button>
      </div>
      <div class="bm-actions">
        <button class="bm-ghost" id="bmEditBack">‹ Back to characters</button>
      </div>`;
    body.querySelector("#bmEditName").addEventListener("change", (e) => {
      updateCompanion(c.id, { name: e.target.value.trim() || "Buddy" }); finishChange();
    });
    body.querySelector("#bmEditFlip").addEventListener("change", (e) => {
      updateCompanion(c.id, { flip: e.target.checked }); finishChange();
    });
    body.querySelector("#bmRegenClips").addEventListener("click", () => regenClips(c.id));
    body.querySelector("#bmRegenLook").addEventListener("click", () => {
      state.mode = "regen"; state.name = c.name || "Buddy"; state.description = c.description || "";
      state.imgCount = 3; state.options = []; state.selected = null;
      state.clips = {
        idle: true, win: has("win"), lose: has("lose"), emote0: has("emote0"), emote1: has("emote1"),
      };
      state.step = "describe"; render();
    });
    body.querySelector("#bmEditBack").addEventListener("click", () => { state.step = "manage"; render(); });
  }

  // Regenerate only the checked clips for an existing character (reuses its
  // stored PixelLab characterId — no re-create).
  async function regenClips(id) {
    const c = getCompanion(id);
    if (!c || !c.characterId || state.busy) return;
    const keys = Array.from(body.querySelectorAll(".bm-clip input[data-key]:checked")).map((el) => el.dataset.key);
    if (!keys.length) { setError("Pick at least one animation to regenerate."); return; }
    const sprite = c.base || (c.idle && c.idle[0]) || DEFAULT_AVATAR;
    state.busy = true; state.error = null; state.step = "animate";
    state.progress = CLIP_DEFS.filter((cd) => keys.includes(cd.key)).map((cd) => ({ key: cd.key, label: cd.label, status: "pending" }));
    render();
    try {
      const { result, emotes } = await runClips(c.characterId, sprite, keys);
      const patch = { ...result };
      if (emotes[0] || emotes[1]) {
        const cur = (c.emotes || []).slice();
        if (emotes[0]) cur[0] = emotes[0];
        if (emotes[1]) cur[1] = emotes[1];
        patch.emotes = [cur[0] || [], cur[1] || []];
      }
      updateCompanion(id, patch);
      state.busy = false; state.step = "edit"; render();
      finishChange();
    } catch (e) {
      state.busy = false; state.step = "edit"; setError(pixelLabErrorMessage(e));
    }
  }

  // ---- step: done ----
  function renderDone() {
    const list = getCompanions();
    const c = list[list.length - 1] || {};
    body.innerHTML = `
      <div class="bm-done">
        <img class="bm-done-sprite" src="${esc(charThumb(c))}" alt="" />
        <p class="bm-lead"><b>${esc(c.name || "Buddy")}</b> is ready! Drag them around the app — they'll cheer your wins, slump on losses, and emote at random.</p>
      </div>
      <div class="bm-actions">
        <button class="primary" id="bmDoneClose">Done</button>
        <button class="bm-ghost" id="bmDoneMore">Add another</button>
      </div>`;
    body.querySelector("#bmDoneClose").addEventListener("click", () => close());
    body.querySelector("#bmDoneMore").addEventListener("click", startAdd);
  }

  // Notify the app so it can rebuild the on-screen companions live.
  function finishChange() { if (onComplete) onComplete(); }

  function close() {
    modalEl.hidden = true;
    finishChange();
  }

  // expose close for the modal scrim/✕ in main.js
  modalEl._closeBuddySetup = close;
}
