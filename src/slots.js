// "My Slots" — favourite OLG games, launch them in their own window. Add via the
// scraped catalogue, a pasted game URL, or the "★ Add to Favourites" button
// injected into the OLG catalogue window. Title + preview image are scraped
// server-side (Rust) so there's no CORS to fight. Each favourite has a category
// (Slot / Arcade / Cards / Live) for filtering.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, patchSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const CATALOG = "https://www.olg.ca/en/casino/all-casino-games.html";
const CATS = ["Slot", "Arcade", "Cards", "Live"];

function loadSlots() {
  return loadSettings().slots || [];
}
function saveSlots(arr) {
  patchSettings({ slots: arr });
}
function slugLabel(url) {
  const m = url.match(/play-([^./]+)\.html/);
  return (m ? m[1] : url).replace(/[^a-z0-9]/gi, "");
}
function slugName(url) {
  const m = url.match(/play-([^./]+)\.html/);
  if (!m) return "Slot";
  return m[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function cleanUrl(url) {
  return (url || "").trim().split("#")[0].split("?")[0];
}
function isGameUrl(url) {
  return /\/casino\/play-[^/]+\.html/.test(url || "");
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Whole card launches the real-money game in its own window.
function playReal(slot) {
  invoke("open_url", {
    label: slugLabel(slot.url) + "_real",
    url: slot.url + "#/real",
    title: slot.name,
  });
}

// ---------- favourites grid ----------
let filter = "all";

function renderGrid() {
  const grid = $("slotsGrid");
  const slots = loadSlots();
  $("slotsMeta").textContent = slots.length ? `${slots.length}` : "";
  grid.innerHTML = "";
  let shown = 0;
  slots.forEach((slot, i) => {
    if (filter !== "all" && (slot.cat || "Slot") !== filter) return;
    shown++;
    const card = document.createElement("div");
    card.className = "slot-card";
    const thumb = slot.img
      ? `<img src="${esc(slot.img)}" alt="" />`
      : `<span class="slot-ph">${esc(slot.name.slice(0, 1).toUpperCase())}</span>`;
    card.innerHTML = `
      ${thumb}
      <span class="slot-cat">${esc(slot.cat || "Slot")}</span>
      <div class="slot-hover">
        <button class="slot-del" title="Remove">&times;</button>
        <button class="slot-edit-btn" title="Set image">&#9998;</button>
        <span class="slot-tip">${esc(slot.name)}</span>
      </div>`;
    card.onclick = () => playReal(slot);
    card.querySelector(".slot-del").onclick = (e) => {
      e.stopPropagation();
      const arr = loadSlots();
      arr.splice(i, 1);
      saveSlots(arr);
      renderGrid();
    };
    card.querySelector(".slot-edit-btn").onclick = (e) => {
      e.stopPropagation();
      openEdit(i);
    };
    grid.appendChild(card);
  });
  const empty = $("slotsEmpty");
  if (!slots.length) {
    empty.hidden = false;
    empty.innerHTML = "No slots yet. Tap <b>+ Add slot</b> to pick from OLG's catalogue.";
  } else if (!shown) {
    empty.hidden = false;
    empty.textContent = `No ${filter} games saved.`;
  } else {
    empty.hidden = true;
  }
}

function addSlot(name, url, img, cat) {
  const clean = cleanUrl(url);
  const arr = loadSlots();
  if (arr.some((s) => s.url === clean)) return false; // already saved
  arr.push({ name: name || slugName(clean), url: clean, img: img || "", cat: cat || "Slot" });
  saveSlots(arr);
  renderGrid();
  return true;
}

// ---------- add / edit modal ----------
let gamesCache = null;
let pickedImg = "";
let chosenCat = "Slot";
let editIndex = null; // null = adding, otherwise the slot being edited

function openModal() {
  $("slotModal").hidden = false;
  showPick();
  loadCatalogue();
  setTimeout(() => $("smSearch").focus(), 50);
}
function closeModal() {
  $("slotModal").hidden = true;
}
function showPick() {
  $("smPick").hidden = false;
  $("smConfig").hidden = true;
  $("smTitle").textContent = "Add a slot";
  $("smSearch").value = "";
  $("smUrl").value = "";
}
function setMsg(text) {
  const m = $("smMsg");
  m.hidden = !text;
  m.textContent = text || "";
}

// Open the config step for adding a freshly-picked game (auto-fills title + image).
function showConfig(name, url) {
  editIndex = null;
  pickedImg = "";
  chosenCat = "Slot";
  openConfigUI("Add a slot", "Add slot", true);
  $("smName").value = name || slugName(url);
  $("smLink").value = url;
  renderThumb(true);
  invoke("fetch_olg_game", { url })
    .then((d) => {
      if ($("smConfig").hidden) return;
      if (d && d.name) $("smName").value = d.name;
      if (d && d.img && !pickedImg) pickedImg = d.img;
      renderThumb();
    })
    .catch(() => renderThumb());
}

// Open the config step to edit an existing favourite.
function openEdit(i) {
  const slot = loadSlots()[i];
  if (!slot) return;
  editIndex = i;
  pickedImg = slot.img || "";
  chosenCat = slot.cat || "Slot";
  $("slotModal").hidden = false;
  openConfigUI("Edit slot", "Save changes", false);
  $("smName").value = slot.name;
  $("smLink").value = slot.url;
  renderThumb();
}

function openConfigUI(title, saveLabel, showBack) {
  $("smPick").hidden = true;
  $("smConfig").hidden = false;
  $("smTitle").textContent = title;
  $("smSave").textContent = saveLabel;
  $("smBack").hidden = !showBack;
  $("smImgUrl").value = "";
  $("smFile").value = "";
  setMsg("");
  syncCatButtons();
}

function syncCatButtons() {
  document.querySelectorAll("#smCats .sm-cat").forEach((b) => {
    b.classList.toggle("active", b.dataset.cat === chosenCat);
  });
}
function renderThumb(loading) {
  const letter = ($("smName").value || "?").slice(0, 1).toUpperCase();
  if (pickedImg) {
    $("smThumb").innerHTML = `<img src="${esc(pickedImg)}" alt="" />`;
  } else if (loading) {
    $("smThumb").innerHTML = `<span class="sm-spin"></span>`;
  } else {
    $("smThumb").innerHTML = `<span>${esc(letter)}</span>`;
  }
}

async function loadCatalogue() {
  if (gamesCache) {
    renderResults("");
    return;
  }
  $("smStatus").hidden = false;
  $("smStatus").textContent = "Loading OLG catalogue…";
  $("smResults").innerHTML = "";
  try {
    gamesCache = await invoke("fetch_olg_games");
    $("smStatus").hidden = true;
    renderResults("");
  } catch (e) {
    $("smStatus").hidden = false;
    $("smStatus").textContent = "Couldn't load the OLG catalogue. " + e;
  }
}

function renderResults(q) {
  const ul = $("smResults");
  const query = q.trim().toLowerCase();
  const list = !gamesCache
    ? []
    : (query ? gamesCache.filter((g) => g.name.toLowerCase().includes(query)) : gamesCache).slice(0, 120);
  ul.innerHTML = "";
  if (gamesCache && !list.length) {
    ul.innerHTML = `<li class="sm-none">No matches.</li>`;
    return;
  }
  for (const g of list) {
    const li = document.createElement("li");
    li.className = "sm-result";
    li.textContent = g.name;
    li.onclick = () => showConfig(g.name, g.url);
    ul.appendChild(li);
  }
}

function fileToDataUri(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function initSlots() {
  renderGrid();
  $("openOlg").addEventListener("click", () =>
    invoke("open_url", { label: "olgcasino", url: CATALOG, title: "OLG Casino" })
  );
  $("addSlot").addEventListener("click", openModal);
  $("smClose").addEventListener("click", closeModal);
  $("smScrim").addEventListener("click", closeModal);
  $("smBack").addEventListener("click", showPick);
  $("smSearch").addEventListener("input", (e) => renderResults(e.target.value));

  // Paste-a-URL → straight into the customise step (auto title + image).
  $("smUrlGo").addEventListener("click", () => {
    const clean = cleanUrl($("smUrl").value);
    if (!isGameUrl(clean)) { $("smStatus").hidden = false; $("smStatus").textContent = "That doesn't look like an OLG game URL."; return; }
    if (loadSlots().some((s) => s.url === clean)) { $("smStatus").hidden = false; $("smStatus").textContent = "Already in your slots."; return; }
    showConfig(slugName(clean), clean);
  });
  $("smUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") $("smUrlGo").click(); });

  // Category picker (modal)
  document.querySelectorAll("#smCats .sm-cat").forEach((b) => {
    b.addEventListener("click", () => { chosenCat = b.dataset.cat; syncCatButtons(); });
  });
  // Category filter (grid)
  document.querySelectorAll("#slotsFilter .sf-chip").forEach((b) => {
    b.addEventListener("click", () => {
      filter = b.dataset.cat;
      document.querySelectorAll("#slotsFilter .sf-chip").forEach((x) => x.classList.toggle("active", x === b));
      renderGrid();
    });
  });

  $("smName").addEventListener("input", () => { if (!pickedImg) renderThumb(); });
  $("smImgUrl").addEventListener("input", (e) => { pickedImg = e.target.value.trim(); renderThumb(); });
  $("smFileBtn").addEventListener("click", () => $("smFile").click());
  $("smFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    pickedImg = await fileToDataUri(f);
    $("smImgUrl").value = "";
    renderThumb();
  });
  $("smSave").addEventListener("click", () => {
    const name = $("smName").value.trim();
    const url = cleanUrl($("smLink").value);
    if (!isGameUrl(url)) { setMsg("Enter a valid OLG game URL (…/casino/play-….html)."); return; }
    const arr = loadSlots();
    if (editIndex != null) {
      if (arr.some((s, j) => j !== editIndex && s.url === url)) { setMsg("Another slot already uses that link."); return; }
      arr[editIndex] = { name: name || slugName(url), url, img: pickedImg || "", cat: chosenCat };
      saveSlots(arr);
      renderGrid();
      closeModal();
    } else {
      if (arr.some((s) => s.url === url)) { setMsg("Already in your slots."); return; }
      addSlot(name, url, pickedImg, chosenCat);
      closeModal();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("slotModal").hidden) closeModal();
  });

  // The OLG window's injected "★ Add to Favourites" button emits this (with the
  // category the user picked from its menu).
  listen("olg-add-fav", async (e) => {
    const url = cleanUrl((e.payload && e.payload.url) || "");
    const cat = (e.payload && e.payload.cat) || "Slot";
    if (!isGameUrl(url) || loadSlots().some((s) => s.url === url)) return;
    let name = "", img = "";
    try {
      const d = await invoke("fetch_olg_game", { url });
      name = d.name || ""; img = d.img || "";
    } catch (err) { /* fall back to slug name */ }
    addSlot(name, url, img, cat);
  });
}
