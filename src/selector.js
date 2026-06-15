import { getCurrentWindow } from "@tauri-apps/api/window";
import { patchSettings } from "./settings.js";

const win = getCurrentWindow();
const rectEl = document.getElementById("rect");
const dimsEl = document.getElementById("dims");

let startX = 0;
let startY = 0;
let dragging = false;

// The selector window covers the primary monitor starting at (0,0), so client
// coordinates map to screen coordinates. Multiply by devicePixelRatio to get
// physical pixels for the backend capture.
const dpr = window.devicePixelRatio || 1;

function showRect(x, y, w, h) {
  rectEl.style.display = "block";
  rectEl.style.left = x + "px";
  rectEl.style.top = y + "px";
  rectEl.style.width = w + "px";
  rectEl.style.height = h + "px";
  dimsEl.style.display = "block";
  dimsEl.style.left = x + "px";
  dimsEl.style.top = Math.max(0, y - 22) + "px";
  dimsEl.textContent = `${Math.round(w * dpr)} × ${Math.round(h * dpr)} px`;
}

window.addEventListener("mousedown", (e) => {
  dragging = true;
  document.body.classList.add("dragging");
  startX = e.clientX;
  startY = e.clientY;
  showRect(startX, startY, 0, 0);
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  showRect(x, y, w, h);
});

window.addEventListener("mouseup", async (e) => {
  if (!dragging) return;
  dragging = false;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);

  if (w < 8 || h < 8) {
    // Too small — treat as cancel.
    await win.close();
    return;
  }

  const region = {
    x: Math.round(x * dpr),
    y: Math.round(y * dpr),
    width: Math.round(w * dpr),
    height: Math.round(h * dpr),
  };
  patchSettings({ region });
  await win.close();
});

window.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") await win.close();
});
