// Shared settings persisted in localStorage (shared across all windows
// since they run on the same origin).

const KEY = "casinospy.settings";

export const DEFAULTS = {
  gameMode: "blackjack", // "blackjack" | "videopoker"
  model: "opus", // always Opus via the local Claude Code CLI
  rules: { decks: 6, h17: false, das: true, surrender: true }, // blackjack
  vpPaytable: "job_96", // video poker pay table preset key
  region: null, // { x, y, width, height } in physical pixels
  autoIntervalMs: 3000,
  ledger: [], // bankroll entries: { type: "deposit"|"withdrawal", amount: number }
  session: { active: false, buyIn: 0, current: 0 }, // live session counter
  sessionsHistory: [], // locked-in past sessions: { buyIn, final, result }
  jiffrey: { chats: [], activeId: null }, // saved chat threads with the butler
  // Pixel-art companion generated via the PixelLab API. Frames are base64 PNG
  // data URIs stored inline. When unconfigured the UI falls back to the default
  // avatar image (a static, CSS-animated sprite).
  buddy: {
    apiKey: "", // PixelLab API key (user-supplied)
    name: "Jeffry", // companion name
    description: "", // text prompt used to generate it
    characterId: null, // PixelLab character id (for adding more emotes later)
    base: null, // chosen base sprite data URI (idle fallback frame)
    idle: [], // animation frames (data URIs)
    win: [],
    lose: [],
    createdAt: 0,
  },
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      rules: { ...DEFAULTS.rules, ...(parsed.rules || {}) },
      session: { ...DEFAULTS.session, ...(parsed.session || {}) },
      jiffrey: { ...DEFAULTS.jiffrey, ...(parsed.jiffrey || {}) },
      buddy: { ...DEFAULTS.buddy, ...(parsed.buddy || {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function patchSettings(patch) {
  const s = loadSettings();
  const next = { ...s, ...patch };
  if (patch.rules) next.rules = { ...s.rules, ...patch.rules };
  saveSettings(next);
  return next;
}
