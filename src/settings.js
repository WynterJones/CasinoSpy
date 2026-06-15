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
  slots: [], // favourited OLG slots: { name, url, img } (img is a data URI or URL)
  // Pixel-art companion generated via the PixelLab API. Frames are base64 PNG
  // data URIs stored inline. When unconfigured the UI falls back to the default
  // avatar image (a static, CSS-animated sprite). Legacy single-buddy field —
  // kept for backward compatibility / migration into `companions` below.
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
  // Multiple pixel-art characters. The PixelLab key is shared per-device; each
  // character carries its own clips, placement and flip. `list[0]` is treated as
  // the "primary" (shown in the session window + spotlight).
  companions: {
    apiKey: "", // shared PixelLab API key
    list: [], // Character[] — see makeCharacter() shape in buddy.js
  },
};

// Build the companions list from a legacy single `buddy` object (one-time
// migration so existing users keep their generated character).
function migrateBuddy(buddy) {
  if (!buddy || !Array.isArray(buddy.idle) || !buddy.idle.length) return null;
  return {
    id: "c_legacy",
    name: buddy.name || "Jeffry",
    description: buddy.description || "",
    characterId: buddy.characterId || null,
    base: buddy.base || (buddy.idle && buddy.idle[0]) || null,
    idle: buddy.idle || [],
    win: buddy.win || [],
    lose: buddy.lose || [],
    emotes: [],
    flip: !!buddy.flip,
    pos: null,
    size: 200,
    hidden: false,
    createdAt: buddy.createdAt || 0,
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const buddy = { ...DEFAULTS.buddy, ...(parsed.buddy || {}) };
    const companions = {
      ...DEFAULTS.companions,
      ...(parsed.companions || {}),
      list: (parsed.companions && Array.isArray(parsed.companions.list)) ? parsed.companions.list : [],
    };
    // One-time migration: lift a legacy single buddy into the companions list.
    if (!companions.list.length) {
      const migrated = migrateBuddy(buddy);
      if (migrated) {
        companions.list = [migrated];
        if (!companions.apiKey && buddy.apiKey) companions.apiKey = buddy.apiKey;
      }
    }
    if (!companions.apiKey && buddy.apiKey) companions.apiKey = buddy.apiKey;
    return {
      ...DEFAULTS,
      ...parsed,
      rules: { ...DEFAULTS.rules, ...(parsed.rules || {}) },
      session: { ...DEFAULTS.session, ...(parsed.session || {}) },
      jiffrey: { ...DEFAULTS.jiffrey, ...(parsed.jiffrey || {}) },
      buddy,
      companions,
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
  if (patch.companions) next.companions = { ...s.companions, ...patch.companions };
  saveSettings(next);
  return next;
}
