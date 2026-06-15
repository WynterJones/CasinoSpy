// Configurable basic-strategy engine for multi-deck (4-8) blackjack.
// Inputs: player cards (ranks), dealer upcard (rank), and rule flags.
// Output: { action, label, reason }.
//
// Actions: HIT, STAND, DOUBLE, SPLIT, SURRENDER.
// Charts follow standard Wizard-of-Odds basic strategy with H17/S17,
// DAS, and late-surrender variations.

export const ACTIONS = {
  HIT: { action: "HIT", label: "HIT" },
  STAND: { action: "STAND", label: "STAND" },
  DOUBLE: { action: "DOUBLE", label: "DOUBLE" },
  SPLIT: { action: "SPLIT", label: "SPLIT" },
  SURRENDER: { action: "SURRENDER", label: "SURRENDER" },
};

// Normalize a rank string to a numeric value. Ace = 11 (soft).
export function cardValue(rank) {
  if (rank == null) return null;
  const r = String(rank).trim().toUpperCase();
  if (r === "A" || r === "ACE") return 11;
  if (r === "K" || r === "Q" || r === "J" || r === "10" || r === "T") return 10;
  const n = parseInt(r, 10);
  if (Number.isFinite(n) && n >= 2 && n <= 10) return n;
  return null;
}

// "Pair rank" used for split decisions: 10/J/Q/K collapse to 10.
function pairRank(rank) {
  const v = cardValue(rank);
  return v; // 11 for ace, 10 for tens
}

// Compute hand total, accounting for soft aces.
export function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const v = cardValue(c);
    if (v == null) continue;
    if (v === 11) {
      aces += 1;
      total += 11;
    } else {
      total += v;
    }
  }
  // Demote aces from 11 to 1 while busting.
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0; // at least one ace still counted as 11
  return { total, soft, aces };
}

const DEFAULT_RULES = {
  decks: 6,
  h17: false, // dealer hits soft 17
  das: true, // double after split allowed
  surrender: true, // late surrender allowed
};

// Main entry point.
export function bestMove(playerCards, dealerCard, rulesInput = {}) {
  const rules = { ...DEFAULT_RULES, ...rulesInput };
  const player = (playerCards || []).filter((c) => cardValue(c) != null);
  const d = cardValue(dealerCard);

  if (player.length < 2 || d == null) {
    return { ...ACTIONS.HIT, reason: "Need at least 2 player cards and a dealer upcard." };
  }

  const isFirstTwo = player.length === 2;
  const canDouble = isFirstTwo;
  const canSurrender = isFirstTwo && rules.surrender;
  const { total, soft } = handTotal(player);

  // 1) Late surrender (only first two cards, before splitting/doubling).
  if (canSurrender && !soft) {
    if (surrenderHard(total, d, rules, player)) {
      return { ...ACTIONS.SURRENDER, reason: `Hard ${total} vs ${dealerLabel(d)}: surrender.` };
    }
  }

  // 2) Pair splitting.
  if (isFirstTwo && pairRank(player[0]) === pairRank(player[1])) {
    const pv = pairRank(player[0]);
    if (shouldSplit(pv, d, rules)) {
      return { ...ACTIONS.SPLIT, reason: `Pair of ${rankName(pv)} vs ${dealerLabel(d)}: split.` };
    }
  }

  // 3) Soft totals.
  if (soft) {
    return resolveDouble(softMove(total, d, rules), canDouble, true, total, d);
  }

  // 4) Hard totals.
  return resolveDouble(hardMove(total, d, rules), canDouble, false, total, d);
}

// ---- Surrender ----
function surrenderHard(total, d, rules, player) {
  // Never surrender a pair of 8s (split instead).
  const isPair88 = player.length === 2 && pairRank(player[0]) === 8 && pairRank(player[1]) === 8;
  if (isPair88) return false;
  if (!rules.h17) {
    if (total === 16 && [9, 10, 11].includes(d)) return true;
    if (total === 15 && d === 10) return true;
  } else {
    if (total === 17 && d === 11) return true;
    if (total === 16 && [9, 10, 11].includes(d)) return true;
    if (total === 15 && [10, 11].includes(d)) return true;
  }
  return false;
}

// ---- Splitting ----
function shouldSplit(pv, d, rules) {
  const das = rules.das;
  switch (pv) {
    case 11: // A,A
      return true;
    case 10: // never split tens
      return false;
    case 9:
      return [2, 3, 4, 5, 6, 8, 9].includes(d); // stand vs 7,10,A
    case 8:
      return true;
    case 7:
      return [2, 3, 4, 5, 6, 7].includes(d);
    case 6:
      return das ? [2, 3, 4, 5, 6].includes(d) : [3, 4, 5, 6].includes(d);
    case 5: // treat as hard 10, never split
      return false;
    case 4:
      return das ? [5, 6].includes(d) : false;
    case 3:
      return das ? [2, 3, 4, 5, 6, 7].includes(d) : [4, 5, 6, 7].includes(d);
    case 2:
      return das ? [2, 3, 4, 5, 6, 7].includes(d) : [4, 5, 6, 7].includes(d);
    default:
      return false;
  }
}

// ---- Soft totals (returns a candidate action) ----
function softMove(total, d, rules) {
  // total is 13..21 (A counted as 11)
  switch (total) {
    case 21:
    case 20:
      return ACTIONS.STAND;
    case 19:
      if (rules.h17 && d === 6) return ACTIONS.DOUBLE; // A,8 vs 6 (H17)
      return ACTIONS.STAND;
    case 18: // A,7
      if (rules.h17) {
        if ([2, 3, 4, 5, 6].includes(d)) return ACTIONS.DOUBLE;
        if ([7, 8].includes(d)) return ACTIONS.STAND;
        return ACTIONS.HIT;
      } else {
        if ([3, 4, 5, 6].includes(d)) return ACTIONS.DOUBLE;
        if ([2, 7, 8].includes(d)) return ACTIONS.STAND;
        return ACTIONS.HIT;
      }
    case 17: // A,6
      return [3, 4, 5, 6].includes(d) ? ACTIONS.DOUBLE : ACTIONS.HIT;
    case 16: // A,5
    case 15: // A,4
      return [4, 5, 6].includes(d) ? ACTIONS.DOUBLE : ACTIONS.HIT;
    case 14: // A,3
    case 13: // A,2
      return [5, 6].includes(d) ? ACTIONS.DOUBLE : ACTIONS.HIT;
    default:
      return ACTIONS.HIT;
  }
}

// ---- Hard totals ----
function hardMove(total, d, rules) {
  if (total >= 17) return ACTIONS.STAND;
  if (total >= 13 && total <= 16) {
    return [2, 3, 4, 5, 6].includes(d) ? ACTIONS.STAND : ACTIONS.HIT;
  }
  if (total === 12) {
    return [4, 5, 6].includes(d) ? ACTIONS.STAND : ACTIONS.HIT;
  }
  if (total === 11) {
    if (d === 11) return rules.h17 ? ACTIONS.DOUBLE : ACTIONS.HIT;
    return ACTIONS.DOUBLE; // double vs 2-10
  }
  if (total === 10) {
    return [2, 3, 4, 5, 6, 7, 8, 9].includes(d) ? ACTIONS.DOUBLE : ACTIONS.HIT;
  }
  if (total === 9) {
    return [3, 4, 5, 6].includes(d) ? ACTIONS.DOUBLE : ACTIONS.HIT;
  }
  return ACTIONS.HIT; // 5-8
}

// If a DOUBLE is recommended but doubling isn't allowed (3+ cards),
// fall back to the correct alternative.
function resolveDouble(move, canDouble, soft, total, d) {
  if (move.action !== "DOUBLE") {
    return { ...move, reason: reasonFor(move, soft, total, d) };
  }
  if (canDouble) {
    return { ...move, reason: reasonFor(move, soft, total, d) };
  }
  // Can't double: soft 18 doubles fall back to STAND, everything else to HIT.
  if (soft && total === 18) {
    return { ...ACTIONS.STAND, reason: `Soft ${total} vs ${dealerLabel(d)}: can't double, stand.` };
  }
  if (soft && total === 19) {
    return { ...ACTIONS.STAND, reason: `Soft ${total} vs ${dealerLabel(d)}: can't double, stand.` };
  }
  return { ...ACTIONS.HIT, reason: `${soft ? "Soft" : "Hard"} ${total} vs ${dealerLabel(d)}: can't double, hit.` };
}

function reasonFor(move, soft, total, d) {
  const kind = soft ? `Soft ${total}` : `Hard ${total}`;
  return `${kind} vs ${dealerLabel(d)}: ${move.label.toLowerCase()}.`;
}

function dealerLabel(d) {
  return d === 11 ? "A" : String(d);
}

function rankName(pv) {
  if (pv === 11) return "Aces";
  if (pv === 10) return "Tens";
  return `${pv}s`;
}
