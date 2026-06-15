// Shared live-session state, synced across all windows via localStorage.
import { loadSettings, patchSettings } from "./settings.js";

export function getSession() {
  return loadSettings().session;
}

export function setSession(patch) {
  const s = loadSettings();
  const next = { ...s.session, ...patch };
  patchSettings({ session: next });
  return next;
}

export function startSession(buyIn) {
  const amt = Math.max(0, Math.round((Number(buyIn) || 0) * 100) / 100);
  return setSession({ active: true, buyIn: amt, current: amt });
}

export function stopSession() {
  return setSession({ active: false });
}

export function adjustCurrent(delta) {
  const s = getSession();
  const cur = Math.max(0, Math.round((s.current + delta) * 100) / 100);
  return setSession({ current: cur });
}

export function setCurrent(value) {
  const cur = Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
  return setSession({ current: cur });
}

export function winLoss(s = getSession()) {
  return Math.round((s.current - s.buyIn) * 100) / 100;
}

export function money(n) {
  return "$" + Math.abs(n).toFixed(2);
}

// Status class + display for a win/loss value.
export function wlState(wl) {
  if (Math.abs(wl) < 0.005) return { cls: "even", arrow: "=", text: "Even" };
  if (wl > 0) return { cls: "up", arrow: "▲", text: "+" + money(wl) };
  return { cls: "down", arrow: "▼", text: "−" + money(wl) };
}

// Subscribe to cross-window session changes. Returns an unsubscribe fn.
export function onSessionChange(cb) {
  const handler = () => cb(getSession());
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
