# ♠ CasinoSpy

A macOS desktop app (Tauri + Rust) that watches a region of your screen, reads the
cards with **your local Claude Code CLI** (Opus vision — no API key), and shows the
**mathematically perfect play** on a floating, always-on-top overlay. Works for
blackjack (live-dealer video, digital tables, OLG/RNG video blackjack) and the full
**IGT Game King** video-poker lineup.

![icon](src-tauri/icons/128x128@2x.png)

## Features

- **Pick any screen region** with a transparent spotlight selector — your blackjack
  table or your 5-card video-poker hand.
- **Local Claude Code OCR** — the cropped region is read by the `claude` CLI on your
  machine (uses your existing subscription, **no Anthropic API key**).
- **Perfect blackjack basic strategy** — configurable decks (incl. *Unlimited* for
  RNG/continuous-shuffle games), dealer hits/stands soft 17 (H17/S17),
  double-after-split, and late surrender. Correct hard/soft/pair/surrender plays with
  "can't double" fallbacks.
- **Exact-EV video poker** for all 9 Game King titles, including true wild-card
  evaluation:
  - Jacks or Better, Bonus Poker, Bonus Poker Deluxe, Double Bonus,
    Double Double Bonus, Triple Double Bonus
  - **Deuces Wild, Deuces Wild Bonus, Joker Poker**
  - The solver brute-forces all 32 holds × every possible draw → the true
    maximum-EV hold (not chart-approximated).
- **Floating overlay** with real card graphics, a colour-coded move
  (HIT / STAND / DOUBLE / SPLIT / SURRENDER) or HOLD/DRAW tags, a confidence meter,
  and a full-window staged "Reading" progress (Capturing → Reading → Analyzing).
- **Two scan modes** — a Scan button + global hotkey **⌘/Ctrl + ⇧ + B**, plus an
  Auto-poll toggle for video play.

## Requirements

- macOS, [Claude Code](https://claude.com/claude-code) installed (`claude` on PATH),
  Node 18+, Rust (stable).

## Run it

```bash
npm install
npm run tauri dev
```

## Build a signed + notarized release

With an Apple **Developer ID Application** certificate in your keychain and these
env vars set (`APPLE_ID`, `APPLE_PASSWORD` app-specific password, `APPLE_TEAM_ID`):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
npm run tauri build
```

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`.

## First-time macOS permissions

CasinoSpy captures the screen, so macOS will prompt for **Screen Recording** the
first time you scan (System Settings → Privacy & Security → Screen Recording). In
`dev`, grant it to your Terminal/IDE; in the built app, grant it to **CasinoSpy**,
then relaunch. The global hotkey may also need Accessibility/Input Monitoring.

## How to use

1. Pick a **game mode** tile (Blackjack or Video Poker).
2. Set the **rules** (blackjack: decks + soft-17/DAS/surrender) or the **Game King
   title** (video poker — match the machine's posted pay table).
3. **Pick region** and drag a box around the whole hand.
4. **Open overlay**, then **Scan** (or ⌘/Ctrl+⇧+B), or toggle **Auto**. Keep the
   overlay *outside* the captured region so it isn't read.

## Project layout

```
index.html / src/main.js        Control panel
overlay.html / src/overlay.js   Floating strategy overlay
selector.html / src/selector.js Screen-region picker
src/strategy.js                 Configurable blackjack basic-strategy engine
src/videopoker.js               Game King video-poker exact-EV solver (wild-aware)
src/scan.js                     Parses Claude's JSON response
src-tauri/src/lib.rs            Rust: screen capture (xcap), Claude CLI, windows, hotkey
```

## How it reads cards

The Rust backend captures the selected region with [`xcap`](https://crates.io/crates/xcap),
writes a temp PNG, and runs the local Claude Code CLI headlessly
(`claude -p … --allowedTools Read --model opus`) to return strict JSON describing the
cards. The strategy/EV engines are pure JavaScript and run instantly client-side.

## Legal / responsible use

For educational and strategy-practice purposes. Many casinos and online operators
prohibit real-time assistance tools — use only where permitted and at your own risk.

## License

MIT
