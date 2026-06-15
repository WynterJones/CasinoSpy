// Parses the raw text Claude returns into structured results.
// Blackjack: { player:[{rank,suit}], dealer:{rank,suit}|null }
// Video poker: { cards:[rank+suit strings] }

function extractJson(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  let text = rawText.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) text = brace[0];
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- Blackjack ----
export function parseBlackjack(rawText) {
  const obj = extractJson(rawText);
  if (!obj) return { player: [], dealer: null, error: "could not parse response" };
  const player = Array.isArray(obj.player) ? obj.player.map(toCard).filter(Boolean) : [];
  const dealer = toCard(obj.dealer);
  return {
    player,
    dealer,
    confidence: typeof obj.confidence === "number" ? obj.confidence : null,
    notes: obj.notes || "",
    error: null,
  };
}

// ---- Video poker ----
export function parseVideoPoker(rawText) {
  const obj = extractJson(rawText);
  if (!obj) return { cards: [], error: "could not parse response" };
  const cards = Array.isArray(obj.cards) ? obj.cards.map(normCard).filter(Boolean) : [];
  return {
    cards,
    confidence: typeof obj.confidence === "number" ? obj.confidence : null,
    notes: obj.notes || "",
    error: null,
  };
}

export function parseScanResult(rawText) {
  return parseBlackjack(rawText);
}

function normRank(r) {
  if (r == null) return "";
  let s = String(r).trim().toUpperCase();
  if (s === "T") return "10";
  if (s === "ACE") return "A";
  if (["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].includes(s)) return s;
  return "";
}

// Parse "rank[suit]" into { rank, suit } where suit may be "" (unknown).
function toCard(c) {
  if (c == null) return null;
  let s = String(c).trim();
  s = s.replace(/♣/gi, "c").replace(/♦/gi, "d").replace(/♥/gi, "h").replace(/♠/gi, "s");
  const m = s.match(/^(10|[2-9TtJjQqKkAa])\s*([cdhsCDHS]?)$/);
  if (!m) return null;
  const rank = normRank(m[1]);
  if (!rank) return null;
  const suit = (m[2] || "").toLowerCase();
  return { rank, suit };
}

// Video poker requires a suit (for flush/straight detection).
function normCard(c) {
  const card = toCard(c);
  if (!card || !card.suit) return "";
  return card.rank + card.suit;
}
