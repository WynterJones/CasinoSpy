// Video poker optimal-play engine for the IGT Game King lineup.
//
// Handles standard (Jacks/Bonus family) games AND wild-card games
// (Deuces Wild, Deuces Wild Bonus, Joker Poker). For any pay table it
// brute-forces all 32 hold patterns and computes the exact expected value
// of each by enumerating every possible draw from the remaining deck, then
// returns the maximum-EV hold — so play is always optimal, not chart-based.
//
// NOTE: pay tables use the common Game King schedules (max-bet convention,
// royal = 800). Match the on-screen pay table for perfect EV; the HOLD
// decision is essentially identical across pay-table variants of a game.

// Rank: 2..14 (J=11, Q=12, K=13, A=14). Suit: 0..3. Joker: rank 0, suit -1.
const SUITS = ["c", "d", "h", "s"];
const RANK_STR = { 0: "JKR", 11: "J", 12: "Q", 13: "K", 14: "A" };

export function parseCard(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (/^(jkr|joker|jk|wild|x)$/i.test(s)) return { rank: 0, suit: -1 };
  s = s.replace(/♣/gi, "c").replace(/♦/gi, "d").replace(/♥/gi, "h").replace(/♠/gi, "s");
  const m = s.match(/^(10|[2-9TJQKA])\s*([cdhs])$/i);
  if (!m) return null;
  let r = m[1].toUpperCase();
  let rank;
  if (r === "A") rank = 14;
  else if (r === "K") rank = 13;
  else if (r === "Q") rank = 12;
  else if (r === "J") rank = 11;
  else if (r === "10" || r === "T") rank = 10;
  else rank = parseInt(r, 10);
  const suit = SUITS.indexOf(m[2].toLowerCase());
  if (rank == null || suit < 0) return null;
  return { rank, suit };
}

export function cardLabel(card) {
  if (!card) return "?";
  if (card.rank === 0) return "JKR";
  const r = RANK_STR[card.rank] || String(card.rank);
  const glyph = ["♣", "♦", "♥", "♠"][card.suit] || "";
  return r + glyph;
}

// ---- analytic hand evaluation (wild-aware) ----
// Returns a structured description of every category the 5 cards can satisfy.
function evaluate(cards, wildMode) {
  const isWild = (c) =>
    wildMode === "deuces" ? c.rank === 2 : wildMode === "joker" ? c.rank === 0 : false;

  const wilds = cards.filter(isWild);
  const naturals = cards.filter((c) => !isWild(c));
  const W = wilds.length;

  const cnt = {};
  for (const c of naturals) cnt[c.rank] = (cnt[c.rank] || 0) + 1;
  const distinctRanks = Object.keys(cnt).map(Number);
  const counts = Object.values(cnt).sort((a, b) => b - a);
  const maxKind = counts[0] || 0;
  const suits = naturals.map((c) => c.suit);
  const sameSuit = suits.length === 0 || suits.every((s) => s === suits[0]);
  const distinct = distinctRanks.length === naturals.length;

  // Straight feasibility (with ace high or low), all naturals distinct.
  function straightOK(ranksList) {
    if (ranksList.length === 0) return true;
    const u = [...new Set(ranksList)];
    if (u.length !== ranksList.length) return false; // duplicate -> no straight
    return Math.max(...u) - Math.min(...u) <= 4;
  }
  const natRanks = naturals.map((c) => c.rank);
  const aceLow = natRanks.map((r) => (r === 14 ? 1 : r));
  const canStraight = distinct && (straightOK(natRanks) || straightOK(aceLow));

  const canFlush = sameSuit; // wilds adopt the suit
  const canStraightFlush = canStraight && canFlush;

  // Royal: straight-flush spanning 10..A.
  const royalHigh = natRanks.every((r) => r >= 10);
  const canRoyal = canStraightFlush && royalHigh && naturals.length > 0 || (canStraightFlush && royalHigh);
  const naturalRoyal = W === 0 && canStraightFlush && royalHigh && naturals.length === 5;
  const wildRoyal = W > 0 && canStraightFlush && royalHigh;

  // Of-a-kind: which ranks can reach 4 / 5 with wilds.
  const ranksToCount = (n) => distinctRanks.filter((r) => cnt[r] + W >= n);
  const fiveRanks = ranksToCount(5);
  const fourRanks = ranksToCount(4);
  const canFive = fiveRanks.length > 0;
  const canFour = fourRanks.length > 0;
  const canThree = maxKind + W >= 3;

  // Four of a kind details (natural games use the quad rank + kicker).
  let quadRank = null, quadKicker = null;
  if (canFour) {
    quadRank = fourRanks.sort((a, b) => b - a)[0];
    if (W === 0) {
      const k = distinctRanks.find((r) => cnt[r] === 1);
      quadKicker = k != null ? k : null;
    }
  }

  // Full house: at most 2 distinct natural ranks, fillable to 3+2.
  let canFullHouse = false;
  if (distinctRanks.length <= 2 && naturals.length >= 1) {
    if (distinctRanks.length === 1) {
      canFullHouse = cnt[distinctRanks[0]] <= 3; // need a second (wild) rank
    } else {
      const [a, b] = distinctRanks.map((r) => cnt[r]).sort((x, y) => y - x); // a>=b
      const need = (g1, g2, c1, c2) =>
        c1 <= g1 && c2 <= g2 && Math.max(0, g1 - c1) + Math.max(0, g2 - c2) <= W;
      canFullHouse = need(3, 2, a, b) || need(3, 2, b, a);
    }
  }

  // Two pair (used by Joker Poker): two distinct natural pairs (no wild needed).
  const naturalPairs = distinctRanks.filter((r) => cnt[r] >= 2).length;
  const canTwoPair = naturalPairs >= 2;

  // Highest pair rank achievable (for Jacks/Kings-or-better).
  let pairRankMax = 0;
  for (const r of distinctRanks) if (cnt[r] + W >= 2) pairRankMax = Math.max(pairRankMax, r);

  return {
    W,
    naturalRoyal, wildRoyal,
    fourDeuces: wildMode === "deuces" && W === 4,
    fourDeucesKicker: wildMode === "deuces" && W === 4 ? (naturals[0] ? naturals[0].rank : null) : null,
    canFive, fiveRanks,
    canStraightFlush,
    canFour, quadRank, quadKicker, fourRanks,
    canFullHouse,
    canFlush,
    canStraight,
    canThree,
    canTwoPair,
    pairRankMax,
  };
}

// ---- pay tables (coins at max bet; royal = 800) ----
const T = (v) => v; // readability

export const PAYTABLES = {
  job_96: {
    name: "Jacks or Better (9/6)", group: "Standard",
    pay(e) {
      if (e.naturalRoyal || e.wildRoyal) return 800;
      if (e.canStraightFlush) return 50;
      if (e.canFour) return 25;
      if (e.canFullHouse) return 9;
      if (e.canFlush) return 6;
      if (e.canStraight) return 4;
      if (e.canThree) return 3;
      if (e.canTwoPair) return 2;
      if (e.pairRankMax >= 11) return 1;
      return 0;
    },
  },
  bonus_85: {
    name: "Bonus Poker (8/5)", group: "Bonus",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.canStraightFlush) return 50;
      if (e.canFour) return e.quadRank === 14 ? 80 : e.quadRank <= 4 ? 40 : 25;
      if (e.canFullHouse) return 8;
      if (e.canFlush) return 5;
      if (e.canStraight) return 4;
      if (e.canThree) return 3;
      if (e.canTwoPair) return 2;
      if (e.pairRankMax >= 11) return 1;
      return 0;
    },
  },
  bpd_96: {
    name: "Bonus Poker Deluxe (9/6)", group: "Bonus",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.canStraightFlush) return 50;
      if (e.canFour) return 80;
      if (e.canFullHouse) return 9;
      if (e.canFlush) return 6;
      if (e.canStraight) return 4;
      if (e.canThree) return 3;
      if (e.canTwoPair) return 1;
      if (e.pairRankMax >= 11) return 1;
      return 0;
    },
  },
  db_975: {
    name: "Double Bonus (9/7/5)", group: "Bonus",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.canStraightFlush) return 50;
      if (e.canFour) return e.quadRank === 14 ? 160 : e.quadRank <= 4 ? 80 : 50;
      if (e.canFullHouse) return 9;
      if (e.canFlush) return 7;
      if (e.canStraight) return 5;
      if (e.canThree) return 3;
      if (e.canTwoPair) return 1;
      if (e.pairRankMax >= 11) return 1;
      return 0;
    },
  },
  ddb_96: {
    name: "Double Double Bonus (9/6)", group: "Bonus",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.canStraightFlush) return 50;
      if (e.canFour) {
        const r = e.quadRank, k = e.quadKicker;
        if (r === 14) return [2, 3, 4].includes(k) ? 400 : 160;
        if (r <= 4) return [14, 2, 3, 4].includes(k) ? 160 : 80;
        return 50;
      }
      if (e.canFullHouse) return 9;
      if (e.canFlush) return 6;
      if (e.canStraight) return 4;
      if (e.canThree) return 3;
      if (e.canTwoPair) return 1;
      if (e.pairRankMax >= 11) return 1;
      return 0;
    },
  },
  tdb_96: {
    name: "Triple Double Bonus (9/6)", group: "Bonus",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.canStraightFlush) return 50;
      if (e.canFour) {
        const r = e.quadRank, k = e.quadKicker;
        if (r === 14) return [2, 3, 4].includes(k) ? 800 : 160;
        if (r <= 4) return [14, 2, 3, 4].includes(k) ? 400 : 80;
        return 50;
      }
      if (e.canFullHouse) return 9;
      if (e.canFlush) return 6;
      if (e.canStraight) return 4;
      if (e.canThree) return 2;
      if (e.canTwoPair) return 1;
      if (e.pairRankMax >= 11) return 1;
      return 0;
    },
  },
  deuces: {
    name: "Deuces Wild (25/15/9/4/4/3)", group: "Wild", wild: "deuces",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.fourDeuces) return 200;
      if (e.wildRoyal) return 25;
      if (e.canFive) return 15;
      if (e.canStraightFlush) return 9;
      if (e.canFour) return 4;
      if (e.canFullHouse) return 4;
      if (e.canFlush) return 3;
      if (e.canStraight) return 2;
      if (e.canThree) return 1;
      return 0;
    },
  },
  deuces_bonus: {
    name: "Deuces Wild Bonus", group: "Wild", wild: "deuces",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.fourDeuces) return e.fourDeucesKicker === 14 ? 400 : 200;
      if (e.wildRoyal) return 25;
      if (e.canFive) {
        // five aces > five 3-5 > five 6-K
        if (e.fiveRanks.includes(14)) return 80;
        if (e.fiveRanks.some((r) => r >= 3 && r <= 5)) return 40;
        return 20;
      }
      if (e.canStraightFlush) return 13;
      if (e.canFour) return 4;
      if (e.canFullHouse) return 4;
      if (e.canFlush) return 3;
      if (e.canStraight) return 2;
      if (e.canThree) return 1;
      return 0;
    },
  },
  joker_kings: {
    name: "Joker Poker (Kings or Better)", group: "Wild", wild: "joker",
    pay(e) {
      if (e.naturalRoyal) return 800;
      if (e.canFive) return 200;
      if (e.wildRoyal) return 100;
      if (e.canStraightFlush) return 50;
      if (e.canFour) return 17;
      if (e.canFullHouse) return 7;
      if (e.canFlush) return 5;
      if (e.canStraight) return 3;
      if (e.canThree) return 2;
      if (e.canTwoPair) return 1;
      if (e.pairRankMax >= 13) return 1; // Kings or Better
      return 0;
    },
  },
};

export const DEFAULT_PAYTABLE = "job_96";

function fullDeck(joker) {
  const d = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) d.push({ rank: r, suit: s });
  if (joker) d.push({ rank: 0, suit: -1 });
  return d;
}

function eachCombo(deck, k, cb) {
  const combo = new Array(k);
  (function rec(start, depth) {
    if (depth === k) { cb(combo); return; }
    for (let i = start; i <= deck.length - (k - depth); i++) {
      combo[depth] = deck[i];
      rec(i + 1, depth + 1);
    }
  })(0, 0);
}

// Returns { mask, held, holdIdx, ev, label }.
export function bestHold(cards, paytableKey = DEFAULT_PAYTABLE) {
  const pt = PAYTABLES[paytableKey] || PAYTABLES[DEFAULT_PAYTABLE];
  const wildMode = pt.wild || null;
  if (!cards || cards.length !== 5 || cards.some((c) => !c)) {
    return { mask: 0, held: [], holdIdx: [], ev: 0, label: "Need 5 cards", error: "need 5 cards" };
  }

  const have = cards;
  const deck = fullDeck(wildMode === "joker").filter(
    (c) => !have.some((h) => h.rank === c.rank && h.suit === c.suit)
  );

  let best = { ev: -1, mask: 0, holdIdx: [], held: [] };
  for (let mask = 0; mask < 32; mask++) {
    const held = [];
    const holdIdx = [];
    for (let i = 0; i < 5; i++) {
      if (mask & (1 << i)) { held.push(have[i]); holdIdx.push(i); }
    }
    const drawCount = 5 - held.length;

    let ev;
    if (drawCount === 0) {
      ev = pt.pay(evaluate(held, wildMode));
    } else {
      let total = 0, n = 0;
      eachCombo(deck, drawCount, (combo) => {
        total += pt.pay(evaluate(held.concat(combo), wildMode));
        n++;
      });
      ev = total / n;
    }

    if (ev > best.ev + 1e-9) best = { ev, mask, held: held.slice(), holdIdx: holdIdx.slice() };
  }

  best.label = describeHold(have, best.holdIdx, wildMode);
  return best;
}

function describeHold(cards, holdIdx, wildMode) {
  const n = holdIdx.length;
  if (n === 0) return "Discard all 5";
  if (n === 5) return "Stand pat";
  const held = holdIdx.map((i) => cards[i]);
  const isWild = (c) =>
    wildMode === "deuces" ? c.rank === 2 : wildMode === "joker" ? c.rank === 0 : false;
  const wilds = held.filter(isWild).length;
  const nat = held.filter((c) => !isWild(c));

  const suits = nat.map((c) => c.suit);
  const ranks = nat.map((c) => c.rank);
  const sameSuit = suits.length > 0 && suits.every((s) => s === suits[0]);
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const maxCount = Math.max(0, ...Object.values(cnt));

  if (wilds && n === wilds) return wilds === 1 ? "Hold the wild" : `Hold ${wilds} wilds`;
  if (sameSuit && nat.every((c) => c.rank >= 10) && n >= 3) return `${n} to a Royal`;
  if (sameSuit && n === 4) return "4 to a Flush";
  if (maxCount + wilds >= 3) return "Three of a Kind";
  if (maxCount + wilds >= 2) {
    const pr = Number(Object.keys(cnt).find((r) => cnt[r] >= 2));
    if (!wilds && n === 2) return pr >= 11 ? "High Pair" : "Pair";
    return "Pair + draw";
  }
  return `Hold ${n}`;
}
