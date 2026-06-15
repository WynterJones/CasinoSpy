use image::codecs::png::PngEncoder;
use image::{imageops, ExtendedColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

#[derive(Debug, Deserialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

// macOS Screen Recording permission. Without it, screen captures come back blank
// (a black frame), which the overlay used to mis-report as "WAITING". We preflight
// the permission and can trigger the system prompt that lists the app under
// System Settings → Privacy & Security → Screen Recording.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

fn screen_capture_allowed() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGPreflightScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// Returns true if access is granted. On macOS, if it isn't, this triggers the
// system permission prompt (and registers the app in the Screen Recording list).
#[tauri::command]
fn ensure_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            return true;
        }
        CGRequestScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

const SCREEN_PERMISSION_MSG: &str =
    "No screen access. Grant CasinoSpy permission in System Settings → Privacy & Security → \
Screen Recording, then quit and reopen the app.";

// Heuristic: a permission-denied capture is a single flat colour (usually black).
// Card tables never are, so a uniform crop means we didn't really capture the screen.
fn is_blank_capture(img: &image::RgbaImage) -> bool {
    let mut pixels = img.pixels();
    let first = match pixels.next() {
        Some(p) => *p,
        None => return true,
    };
    let total = (img.width() as usize) * (img.height() as usize);
    let step = (total / 4096).max(1);
    for (i, p) in img.pixels().enumerate() {
        if i % step != 0 {
            continue;
        }
        let d = (p[0] as i32 - first[0] as i32).abs()
            + (p[1] as i32 - first[1] as i32).abs()
            + (p[2] as i32 - first[2] as i32).abs();
        if d > 12 {
            return false;
        }
    }
    true
}

fn blackjack_prompt(img_path: &str) -> String {
    format!(
        "Use the Read tool to open the image file at {img_path}. \
It is a screenshot of a blackjack game (live dealer video, digital table, or a video-blackjack machine). \
Identify the PLAYER's cards and the DEALER's single face-up card, each with rank AND suit when visible. \
Reply with ONLY one line of minified JSON and nothing else (no prose, no code fences): \
{{\"player\":[\"<rank><suit>\",...],\"dealer\":\"<rank><suit>\",\"confidence\":<0..1>,\"notes\":\"<short>\"}}. \
Rank is one of A,2,3,4,5,6,7,8,9,10,J,Q,K (use 10 for tens). \
Suit is one lowercase letter: c=clubs, d=diamonds, h=hearts, s=spades (e.g. \"6h\",\"10s\",\"Ac\"). \
If a suit is not clearly visible, give just the rank (e.g. \"6\"). \
If the player has split hands, return the active/leftmost hand. \
If a value is unreadable use empty arrays/empty string and lower confidence."
    )
}

fn videopoker_prompt(img_path: &str) -> String {
    format!(
        "Use the Read tool to open the image file at {img_path}. \
It is a video poker hand showing 5 cards. Identify ALL 5 cards, each with its rank AND suit. \
Reply with ONLY one line of minified JSON and nothing else (no prose, no code fences): \
{{\"cards\":[\"<rank><suit>\", ... 5 entries],\"confidence\":<0..1>,\"notes\":\"<short>\"}}. \
Rank is one of A,2,3,4,5,6,7,8,9,10,J,Q,K (use 10 for tens). \
Suit is one lowercase letter: c=clubs, d=diamonds, h=hearts, s=spades. Example: \"Ah\",\"10d\",\"Ks\". \
List the 5 cards left to right. If a card is unreadable, lower confidence."
    )
}

/// Capture the selected region (physical pixels) and return raw PNG bytes.
fn capture_region_png(region: &Region) -> Result<Vec<u8>, String> {
    let monitors = Monitor::all().map_err(|e| format!("monitor enum failed: {e}"))?;
    if monitors.is_empty() {
        return Err("no monitors found".into());
    }

    let mut chosen = None;
    for m in &monitors {
        if m.is_primary().unwrap_or(false) {
            chosen = Some(m);
            break;
        }
    }
    let monitor = chosen.unwrap_or(&monitors[0]);

    let mon_x = monitor.x().unwrap_or(0);
    let mon_y = monitor.y().unwrap_or(0);

    let full = monitor
        .capture_image()
        .map_err(|e| format!("capture failed: {e}"))?;
    let (fw, fh) = (full.width(), full.height());

    let rx = (region.x as i64 - mon_x as i64).max(0) as u32;
    let ry = (region.y as i64 - mon_y as i64).max(0) as u32;
    if rx >= fw || ry >= fh {
        return Err("region is outside the captured monitor".into());
    }
    let rw = region.width.min(fw.saturating_sub(rx)).max(1);
    let rh = region.height.min(fh.saturating_sub(ry)).max(1);

    let cropped = imageops::crop_imm(&full, rx, ry, rw, rh).to_image();

    // A flat/black crop means the OS denied screen access (or nothing was on screen).
    if is_blank_capture(&cropped) {
        return Err(SCREEN_PERMISSION_MSG.to_string());
    }

    let mut buf: Vec<u8> = Vec::new();
    PngEncoder::new(&mut buf)
        .write_image(cropped.as_raw(), cropped.width(), cropped.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(buf)
}

/// Locate the Claude Code CLI binary on this machine.
fn resolve_claude() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CLAUDE_CLI_PATH") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }

    // Ask the user's login shell (GUI apps don't inherit shell PATH).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = Command::new(&shell).arg("-lc").arg("command -v claude").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let pb = PathBuf::from(&p);
            if !p.is_empty() && pb.exists() {
                return Some(pb);
            }
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.claude/local/claude"),
        format!("{home}/.local/bin/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        format!("{home}/.npm-global/bin/claude"),
        format!("{home}/.bun/bin/claude"),
        format!("{home}/.volta/bin/claude"),
    ];
    for c in candidates {
        let pb = PathBuf::from(&c);
        if pb.exists() {
            return Some(pb);
        }
    }
    None
}

/// Run the Claude Code CLI in headless mode against the captured image.
fn run_claude(claude: &Path, prompt: &str, model: &str, workdir: &Path) -> Result<String, String> {
    let mut cmd = Command::new(claude);
    cmd.arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("text")
        .arg("--allowedTools")
        .arg("Read")
        .current_dir(workdir);
    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch Claude Code CLI: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "Claude Code CLI exited with {}: {}{}",
            out.status.code().unwrap_or(-1),
            err.trim(),
            stdout.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn check_cli() -> Result<String, String> {
    match resolve_claude() {
        Some(p) => Ok(p.to_string_lossy().to_string()),
        None => Err("could not find the `claude` CLI. Install Claude Code, or set CLAUDE_CLI_PATH.".into()),
    }
}

fn emit_stage(app: &tauri::AppHandle, stage: &str) {
    let _ = app.emit("scan-progress", stage.to_string());
}

#[tauri::command]
async fn scan(app: tauri::AppHandle, region: Region, mode: String, model: String) -> Result<String, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let claude = resolve_claude()
            .ok_or_else(|| "Claude Code CLI not found. Set CLAUDE_CLI_PATH or install Claude Code.".to_string())?;

        if !screen_capture_allowed() {
            return Err(SCREEN_PERMISSION_MSG.to_string());
        }

        emit_stage(&app2, "capturing");
        let png = capture_region_png(&region)?;

        let dir = std::env::temp_dir();
        let path = dir.join(format!("casinospy_scan_{}.png", std::process::id()));
        std::fs::write(&path, &png).map_err(|e| format!("could not write temp image: {e}"))?;
        let path_str = path.to_string_lossy().to_string();

        let prompt = if mode == "videopoker" {
            videopoker_prompt(&path_str)
        } else {
            blackjack_prompt(&path_str)
        };

        emit_stage(&app2, "reading");
        run_claude(&claude, &prompt, &model, &dir)
    })
    .await
    .map_err(|e| format!("scan task failed: {e}"))?
}

#[tauri::command]
fn open_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("CasinoSpy Overlay")
        .inner_size(340.0, 420.0)
        .min_inner_size(280.0, 360.0)
        .position(80.0, 80.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("overlay build failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_selector(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("selector") {
        let _ = w.set_focus();
        return Ok(());
    }

    let (lw, lh) = match app.primary_monitor() {
        Ok(Some(m)) => {
            let s = m.size();
            let scale = m.scale_factor();
            ((s.width as f64 / scale), (s.height as f64 / scale))
        }
        _ => (1440.0, 900.0),
    };

    WebviewWindowBuilder::new(&app, "selector", WebviewUrl::App("selector.html".into()))
        .title("Select region")
        .inner_size(lw, lh)
        .position(0.0, 0.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("selector build failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_slots_data(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("slotsdata") {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse("https://olgtracker.ca/").map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, "slotsdata", WebviewUrl::External(url))
        .title("OLG Slots Data")
        .inner_size(430.0, 920.0)
        .min_inner_size(360.0, 600.0)
        .resizable(true)
        .user_agent(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        )
        .build()
        .map_err(|e| format!("slots data window failed: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
struct OlgGame {
    name: String,
    url: String,
}

const DESKTOP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&#039;", "'")
        .replace("&rsquo;", "\u{2019}")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&nbsp;", " ")
}

// Scrape the OLG all-casino-games catalogue (server-rendered <a> links) into a
// deduped, alphabetised list of { name, full play URL }.
#[tauri::command]
fn fetch_olg_games() -> Result<Vec<OlgGame>, String> {
    let body = ureq::get("https://www.olg.ca/en/casino/all-casino-games.html")
        .set("User-Agent", DESKTOP_UA)
        .set("Accept", "text/html")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("OLG request failed: {e}"))?
        .into_string()
        .map_err(|e| format!("OLG read failed: {e}"))?;

    let link = regex::Regex::new(r#"(?s)<a[^>]+href="(/en/casino/play-[^"]+\.html)"[^>]*>(.*?)</a>"#)
        .map_err(|e| e.to_string())?;
    let tags = regex::Regex::new(r"<[^>]+>").map_err(|e| e.to_string())?;

    // Each game has several anchors for the same URL (a "Learn More" and a
    // "Play Now" CTA plus the real title link). Keep the longest non-generic
    // text per URL as the display name.
    let generic = |s: &str| {
        matches!(
            s.to_lowercase().trim(),
            "" | "learn more" | "play now" | "play" | "demo" | "real" | "play for free" | "try demo"
        )
    };
    let mut best: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for cap in link.captures_iter(&body) {
        let path = cap[1].to_string();
        let inner = tags.replace_all(&cap[2], " ");
        let text = decode_entities(inner.split_whitespace().collect::<Vec<_>>().join(" ").trim());
        if generic(&text) {
            continue;
        }
        best.entry(path)
            .and_modify(|cur| {
                if text.len() > cur.len() {
                    *cur = text.clone();
                }
            })
            .or_insert(text);
    }

    let mut out: Vec<OlgGame> = best
        .into_iter()
        .map(|(path, name)| OlgGame {
            name,
            url: format!("https://www.olg.ca{path}"),
        })
        .collect();
    if out.is_empty() {
        return Err("No games found — OLG page layout may have changed.".into());
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OlgDetail {
    name: String,
    img: String,
    min_bet: String,
    rtp: String,
    bonus: bool,
    free_spins: bool,
}

// OLG game pages render a spec table:
//   <span class="... title-pb">Min Bet</span> <span class="... value-ob">$0.75</span>
// Pull the value-ob that immediately follows the given label.
fn extract_spec(body: &str, label: &str) -> String {
    let pat = format!(
        r#"(?is)>\s*{}\s*</span>\s*<span[^>]*value-ob[^>]*>\s*([^<]+?)\s*</span>"#,
        regex::escape(label)
    );
    regex::Regex::new(&pat)
        .ok()
        .and_then(|re| re.captures(body).map(|c| decode_entities(c[1].trim())))
        .unwrap_or_default()
}

// OLG embeds the carousel art folder in og:image as `…/ewma/meganav.png`, a tiny
// 192×80 logo that letterboxes in the (16:9) grid. The same folder holds a sharp
// 16:9 `desktop-carousel-logo.png` — prefer it, fall back to whatever og:image is.
fn best_thumb(og_url: &str) -> String {
    if og_url.ends_with("meganav.png") {
        let alt = og_url.replace("meganav.png", "desktop-carousel-logo.png");
        if let Some(d) = download_thumb(&alt) {
            return d;
        }
    }
    download_thumb(og_url).unwrap_or_default()
}

// Pull the `content="..."` out of the first <meta> tag bearing the given
// og:/twitter: key (attribute order independent).
fn meta_content(body: &str, key: &str) -> Option<String> {
    let tag = regex::Regex::new(&format!(
        r#"(?is)<meta[^>]*(?:property|name)="{}"[^>]*>"#,
        regex::escape(key)
    ))
    .ok()?;
    let m = tag.find(body)?;
    let content = regex::Regex::new(r#"(?is)content="([^"]*)""#).ok()?;
    let cap = content.captures(m.as_str())?;
    Some(decode_entities(cap[1].trim()))
}

// "Trinity Pots Rising Wilds – Bonus Pot Slot – Play on OLG.ca" -> "Trinity Pots Rising Wilds".
fn clean_title(t: &str) -> String {
    let mut s = t.to_string();
    for sep in [" \u{2013} ", " \u{2014} ", " | ", " - "] {
        if let Some(i) = s.find(sep) {
            s.truncate(i);
        }
    }
    s.trim().to_string()
}

// Download an image and re-encode it as a small JPEG data URI so favourites stay
// light in localStorage.
fn download_thumb(url: &str) -> Option<String> {
    use std::io::Read;
    let resp = ureq::get(url)
        .set("User-Agent", DESKTOP_UA)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .ok()?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(12_000_000)
        .read_to_end(&mut bytes)
        .ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    // Preserve the (usually landscape) aspect ratio; only shrink very large art,
    // never upscale small thumbnails. Flatten to RGB — JPEG can't carry alpha.
    let scaled = if img.width() > 900 {
        img.thumbnail(900, 900)
    } else {
        img
    };
    let rgb = image::DynamicImage::ImageRgb8(scaled.to_rgb8());
    let mut out = std::io::Cursor::new(Vec::new());
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
    enc.encode_image(&rgb).ok()?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(out.get_ref());
    Some(format!("data:image/jpeg;base64,{b64}"))
}

// Scrape a single OLG game page for its title + preview image (downloaded inline).
#[tauri::command]
fn fetch_olg_game(url: String) -> Result<OlgDetail, String> {
    if !url.contains("/casino/play-") {
        return Err("Not an OLG game URL.".into());
    }
    let clean = url
        .split('#')
        .next()
        .unwrap_or(&url)
        .split('?')
        .next()
        .unwrap_or(&url)
        .to_string();
    let body = ureq::get(&clean)
        .set("User-Agent", DESKTOP_UA)
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("OLG request failed: {e}"))?
        .into_string()
        .map_err(|e| format!("OLG read failed: {e}"))?;

    let name = meta_content(&body, "og:title")
        .or_else(|| meta_content(&body, "twitter:title"))
        .map(|t| clean_title(&t))
        .filter(|t| !t.is_empty())
        .unwrap_or_default();

    let img = meta_content(&body, "og:image")
        .or_else(|| meta_content(&body, "twitter:image"))
        .map(|u| {
            if u.starts_with('/') {
                format!("https://www.olg.ca{u}")
            } else {
                u
            }
        })
        .map(|u| best_thumb(&u))
        .unwrap_or_default();

    // Real specs straight off the page's overview table.
    let min_bet = extract_spec(&body, "Min Bet");
    let rtp = regex::Regex::new(r#"rtpString="([^"]+)""#)
        .ok()
        .and_then(|re| re.captures(&body).map(|c| c[1].trim().to_string()))
        .unwrap_or_default();
    // The game config JSON carries a free-spins flag (HTML-entity-encoded). True on
    // either web or app counts as "has free spins".
    let free_spins = regex::Regex::new(r#"(?is)freeSpins.{0,140}?enabled(?:&#34;|"|\\)*\s*:\s*true"#)
        .map(|re| re.is_match(&body))
        .unwrap_or(false);
    // Bonus isn't a clean flag — fall back to the marketing copy (title + description)
    // so footer/nav text elsewhere on the page doesn't trip every game.
    let desc = meta_content(&body, "og:description")
        .or_else(|| meta_content(&body, "twitter:description"))
        .unwrap_or_default();
    let bonus = format!("{} {}", name, desc).to_lowercase().contains("bonus");

    Ok(OlgDetail { name, img, min_bet, rtp, bonus, free_spins })
}

const OLG_FAV_SCRIPT: &str = r#"
(function(){
  if (window.__casinospyFav) return;
  window.__casinospyFav = true;
  function onPlay(){ return /\/casino\/play-/.test(location.pathname); }
  function gameName(){
    var t=(document.title||'').replace(/\s*[|–—\-].*$/,'').trim();
    if(t && t.toLowerCase()!=='olg' && t.length>1) return t;
    var m=location.pathname.match(/play-([^.\/]+)\.html/);
    return m? m[1].replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();}) : 'Slot';
  }
  function toast(msg){
    var t=document.createElement('div'); t.textContent=msg;
    t.style.cssText='position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:2147483647;background:rgba(8,30,21,.97);color:#fff6db;border:1px solid #f2c94c;padding:9px 16px;border-radius:999px;font:700 13px system-ui;box-shadow:0 10px 26px rgba(0,0,0,.5)';
    document.body.appendChild(t); setTimeout(function(){ t.remove(); },1900);
  }
  var CATS=['Slot','Arcade','Cards','Live'];
  function emitFav(cat){
    var payload={url:location.href,name:gameName(),cat:cat};
    try{ if(window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit){ window.__TAURI__.event.emit('olg-add-fav',payload); return true; } }catch(e){}
    try{ if(window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke){ window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'olg-add-fav',payload:payload}); return true; } }catch(e){}
    return false;
  }
  var menu=null;
  function closeMenu(){ if(menu){ menu.remove(); menu=null; } }
  function openMenu(){
    closeMenu();
    menu=document.createElement('div');
    menu.style.cssText='position:fixed;right:18px;bottom:66px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;background:rgba(8,30,21,.98);border:1px solid #f2c94c;border-radius:14px;padding:8px;box-shadow:0 14px 32px rgba(0,0,0,.55)';
    var h=document.createElement('div'); h.textContent='Add as…'; h.style.cssText='color:#b8c8b7;font:800 10px system-ui;letter-spacing:1px;text-transform:uppercase;padding:2px 6px 4px';
    menu.appendChild(h);
    CATS.forEach(function(c){
      var o=document.createElement('button'); o.textContent=c;
      o.style.cssText='text-align:left;background:rgba(0,0,0,.3);color:#ffe49a;border:1px solid rgba(255,226,142,.3);border-radius:9px;padding:9px 16px;font:800 13px system-ui;cursor:pointer';
      o.onmouseenter=function(){ o.style.background='linear-gradient(180deg,#f6d26a,#d9a93a)'; o.style.color='#2a1d04'; };
      o.onmouseleave=function(){ o.style.background='rgba(0,0,0,.3)'; o.style.color='#ffe49a'; };
      o.onclick=function(ev){ ev.stopPropagation(); closeMenu(); if(emitFav(c)) toast('✓ Added to '+c); else toast('Could not add — try again'); };
      menu.appendChild(o);
    });
    document.body.appendChild(menu);
  }
  var CAT='https://www.olg.ca/en/casino/all-casino-games.html';
  function onCat(){ return /all-casino-games/.test(location.pathname); }
  function sync(){
    var b=document.getElementById('cspy-fav'); if(b) b.style.display=onPlay()?'flex':'none';
    var k=document.getElementById('cspy-back'); if(k) k.style.display=onCat()?'none':'flex';
    if(!onPlay()) closeMenu();
  }
  function mk(){
    if(!document.getElementById('cspy-back')){
      var k=document.createElement('button'); k.id='cspy-back';
      k.innerHTML='‹ All Casinos';
      k.style.cssText='position:fixed;left:18px;bottom:18px;z-index:2147483647;align-items:center;gap:8px;background:rgba(8,30,21,.96);color:#fff6db;border:1px solid #f2c94c;padding:12px 18px;border-radius:999px;font:800 14px system-ui;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.5)';
      k.onmouseenter=function(){ k.style.filter='brightness(1.12)'; };
      k.onmouseleave=function(){ k.style.filter='none'; };
      k.onclick=function(ev){ ev.stopPropagation(); location.href=CAT; };
      document.body.appendChild(k);
    }
    if(document.getElementById('cspy-fav')) { sync(); return; }
    var b=document.createElement('button'); b.id='cspy-fav';
    b.innerHTML='★ Add to Favourites';
    b.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;align-items:center;gap:8px;background:linear-gradient(180deg,#f6d26a,#d9a93a);color:#2a1d04;border:1px solid rgba(255,255,255,.4);padding:12px 18px;border-radius:999px;font:800 14px system-ui;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.5)';
    b.onmouseenter=function(){ b.style.filter='brightness(1.06)'; };
    b.onmouseleave=function(){ b.style.filter='none'; };
    b.onclick=function(ev){ ev.stopPropagation(); if(menu) closeMenu(); else openMenu(); };
    document.body.appendChild(b); sync();
  }
  document.addEventListener('click', function(){ closeMenu(); });
  function boot(){ mk(); }
  if(document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  setTimeout(sync, 1500);
})();
"#;

// Injected into per-game play windows: a draggable poker-chip "pull counter".
// Any click anywhere on the page counts a spin (clicks on the chip's own controls
// are ignored); toggle counting on/off; drag to reposition; set a max limit that
// pops a full-window overlay when reached. State persists
// per game in localStorage. "Close window" rounds a `slot-close` event back to the
// app (the remote page can't close its own native window). `__CSPY_LABEL__` is
// replaced with this window's label so the app knows which window to close.
const COUNTER_SCRIPT: &str = r#"
(function(){
  if (window.__casinospyChip) return;
  window.__casinospyChip = true;
  var LABEL = "__CSPY_LABEL__";
  var KEY = "casinospy_chip::" + location.pathname;
  var S = { n:0, limit:0, cap:0, on:true, x:null, y:null };
  try { var saved = JSON.parse(localStorage.getItem(KEY)); if (saved) S = Object.assign(S, saved); } catch(e){}
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(S)); } catch(e){} }

  var css = document.createElement('style');
  css.textContent = ''
    + '.cspy-w{position:fixed;z-index:2147483646;right:20px;bottom:96px;font-family:system-ui,-apple-system,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none}'
    + '.cspy-w.placed{right:auto;bottom:auto}'
    + '.cspy-tools{display:flex;gap:6px;justify-content:center;margin-bottom:8px;opacity:0;transform:translateY(4px);transition:.15s;pointer-events:none}'
    + '.cspy-w:hover .cspy-tools{opacity:1;transform:none;pointer-events:auto}'
    + '.cspy-tb{width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,226,142,.35);background:rgba(8,30,21,.96);color:#ffe49a;font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(0,0,0,.45);line-height:1}'
    + '.cspy-tb:hover{background:linear-gradient(180deg,#f6d26a,#d9a93a);color:#2a1d04;border-color:rgba(255,255,255,.5)}'
    + '.cspy-tb.live{background:#1f8a4c;color:#fff;border-color:rgba(255,255,255,.4)}'
    + '.cspy-chip{position:relative;width:78px;height:78px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;'
    + 'background:repeating-conic-gradient(from 0deg,#0c5a30 0deg 18deg,#f3f6f4 18deg 36deg);'
    + 'box-shadow:0 12px 26px rgba(0,0,0,.55),inset 0 0 0 2px rgba(0,0,0,.25);transition:transform .08s}'
    + '.cspy-chip:active{transform:scale(.93)}'
    + '.cspy-chip.off{filter:grayscale(.85) brightness(.8);cursor:default}'
    + '.cspy-disc{position:absolute;inset:9px;border-radius:50%;background:radial-gradient(circle at 50% 38%,#15351f,#0a2114);border:3px solid #e7c25c;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:inset 0 2px 6px rgba(0,0,0,.6)}'
    + '.cspy-n{color:#ffe9a6;font-weight:900;font-size:24px;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,.6)}'
    + '.cspy-lab{color:#9fd8b3;font-weight:800;font-size:8px;letter-spacing:1.5px;margin-top:2px;text-transform:uppercase}'
    + '.cspy-pop{position:absolute;bottom:88px;right:0;width:188px;background:rgba(8,30,21,.98);border:1px solid #f2c94c;border-radius:14px;padding:12px;box-shadow:0 16px 36px rgba(0,0,0,.6);display:none;flex-direction:column;gap:8px}'
    + '.cspy-pop.show{display:flex}'
    + '.cspy-pop label{color:#b8c8b7;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase}'
    + '.cspy-pop .row{display:flex;gap:6px;align-items:center}'
    + '.cspy-pop input{flex:1;background:rgba(0,0,0,.35);border:1px solid rgba(255,226,142,.3);border-radius:8px;color:#ffe49a;font-size:14px;font-weight:700;padding:7px 9px;width:100%}'
    + '.cspy-pop button{background:linear-gradient(180deg,#f6d26a,#d9a93a);color:#2a1d04;border:none;border-radius:8px;padding:8px;font-weight:800;font-size:12px;cursor:pointer}'
    + '.cspy-pop .ghost{background:rgba(0,0,0,.3);color:#ffe49a;border:1px solid rgba(255,226,142,.3)}'
    + '.cspy-ov{position:fixed;inset:0;z-index:2147483647;background:rgba(4,12,8,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center}'
    + '.cspy-ov.show{display:flex}'
    + '.cspy-card{width:340px;max-width:88vw;background:linear-gradient(180deg,#0e2e1d,#08200f);border:1px solid #f2c94c;border-radius:20px;padding:26px 24px;text-align:center;box-shadow:0 30px 70px rgba(0,0,0,.7)}'
    + '.cspy-card .big{font-size:46px;font-weight:900;color:#ffe9a6;line-height:1;text-shadow:0 2px 6px rgba(0,0,0,.5)}'
    + '.cspy-card h2{margin:14px 0 4px;color:#fff6db;font-size:19px;font-weight:800}'
    + '.cspy-card p{margin:0 0 20px;color:#a7c4ad;font-size:13px}'
    + '.cspy-card .btns{display:flex;flex-direction:column;gap:9px}'
    + '.cspy-card .btns button{padding:13px;border-radius:11px;font-weight:800;font-size:14px;cursor:pointer;border:none}'
    + '.cspy-card .stop{background:linear-gradient(180deg,#ff6a5a,#d83b2c);color:#fff}'
    + '.cspy-card .go{background:rgba(255,255,255,.08);color:#ffe49a;border:1px solid rgba(255,226,142,.35)}';
  (document.head||document.documentElement).appendChild(css);

  var wrap = document.createElement('div'); wrap.className='cspy-w';
  wrap.innerHTML = ''
    + '<div class="cspy-pop" id="cspyPop">'
    +   '<label>Pull limit (0 = off)</label>'
    +   '<div class="row"><input id="cspyLimit" type="number" min="0" step="1" inputmode="numeric"></div>'
    +   '<button id="cspyReset" class="ghost" type="button">Reset count</button>'
    + '</div>'
    + '<div class="cspy-tools">'
    +   '<button class="cspy-tb" id="cspyPower" title="Counting on/off">II</button>'
    +   '<button class="cspy-tb" id="cspyMinus" title="Undo one">&minus;</button>'
    +   '<button class="cspy-tb" id="cspyGear" title="Limit & settings">&#9881;</button>'
    + '</div>'
    + '<div class="cspy-chip" id="cspyChip"><div class="cspy-disc"><span class="cspy-n" id="cspyN">0</span><span class="cspy-lab">pulls</span></div></div>';

  var ov = document.createElement('div'); ov.className='cspy-ov';
  ov.innerHTML = ''
    + '<div class="cspy-card">'
    +   '<div class="big" id="cspyOvN">0</div>'
    +   '<h2>Pull limit reached</h2>'
    +   '<p id="cspyOvP">You set a limit of 0 pulls.</p>'
    +   '<div class="btns">'
    +     '<button class="stop" id="cspyClose" type="button">Close this game window</button>'
    +     '<button class="go" id="cspyKeep" type="button">Keep playing</button>'
    +   '</div>'
    + '</div>';

  function boot(){
    document.body.appendChild(wrap);
    document.body.appendChild(ov);
    wire();
    apply();
  }

  var chip=null,nEl=null,pop=null,power=null;
  function apply(){
    nEl.textContent = S.n;
    document.getElementById('cspyOvN').textContent = S.n;
    chip.classList.toggle('off', !S.on);
    power.classList.toggle('live', S.on);
    power.textContent = S.on ? 'II' : '▶';
    document.getElementById('cspyLimit').value = S.limit || 0;
    if (S.x != null && S.y != null){
      wrap.classList.add('placed');
      wrap.style.left = S.x + 'px';
      wrap.style.top = S.y + 'px';
    }
  }
  function showLimitOverlay(){
    document.getElementById('cspyOvN').textContent = S.n;
    document.getElementById('cspyOvP').textContent = 'You set a limit of ' + S.cap + ' pulls.';
    ov.classList.add('show');
  }
  function bump(){
    if (!S.on) return;
    S.n++; save(); apply();
    chip.style.transform='scale(1.12)'; setTimeout(function(){chip.style.transform='';},90);
    if (S.limit > 0 && S.n >= S.cap) showLimitOverlay();
  }
  function closeWin(){
    var p = { label: LABEL };
    try { if (window.__TAURI__ && window.__TAURI__.event) { window.__TAURI__.event.emit('slot-close', p); return; } } catch(e){}
    try { if (window.__TAURI_INTERNALS__) { window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'slot-close',payload:p}); return; } } catch(e){}
  }

  function wire(){
    chip = document.getElementById('cspyChip');
    nEl = document.getElementById('cspyN');
    pop = document.getElementById('cspyPop');
    power = document.getElementById('cspyPower');

    // tap-to-count vs drag-to-move on the chip
    var down=null, moved=false;
    chip.addEventListener('pointerdown', function(e){
      down={x:e.clientX,y:e.clientY,l:wrap.getBoundingClientRect().left,t:wrap.getBoundingClientRect().top};
      moved=false; chip.setPointerCapture(e.pointerId);
    });
    chip.addEventListener('pointermove', function(e){
      if(!down) return;
      var dx=e.clientX-down.x, dy=e.clientY-down.y;
      if(Math.abs(dx)>5||Math.abs(dy)>5){
        moved=true;
        var nl=Math.max(4,Math.min(window.innerWidth-86,down.l+dx));
        var nt=Math.max(4,Math.min(window.innerHeight-86,down.t+dy));
        wrap.classList.add('placed'); wrap.style.left=nl+'px'; wrap.style.top=nt+'px';
      }
    });
    chip.addEventListener('pointerup', function(e){
      if(!down) return;
      try{chip.releasePointerCapture(e.pointerId);}catch(_){}
      if(moved){ var r=wrap.getBoundingClientRect(); S.x=r.left; S.y=r.top; save(); }
      else { bump(); }
      down=null;
    });

    power.onclick=function(){ S.on=!S.on; save(); apply(); };
    document.getElementById('cspyMinus').onclick=function(){ if(S.n>0){S.n--; save(); apply();} };
    document.getElementById('cspyGear').onclick=function(){ pop.classList.toggle('show'); };
    document.getElementById('cspyReset').onclick=function(){ S.n=0; if(S.limit>0)S.cap=S.limit; save(); apply(); pop.classList.remove('show'); };
    document.getElementById('cspyLimit').onchange=function(e){
      var v=Math.max(0,parseInt(e.target.value,10)||0); S.limit=v;
      S.cap = v>0 ? (Math.floor(S.n/v)+1)*v : 0;
      save(); apply();
    };
    document.getElementById('cspyClose').onclick=closeWin;
    document.getElementById('cspyKeep').onclick=function(){ S.cap += (S.limit||0); save(); ov.classList.remove('show'); };

    // Count a pull on any click across the page — not just on the chip. Ignore
    // clicks on our own widget/overlay so the tool buttons and drag don't tally.
    document.addEventListener('click', function(e){
      if (wrap.contains(e.target) || ov.contains(e.target)) return;
      bump();
    }, true);
  }

  if(document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
"#;

// Open any external URL in its own native window (used for the OLG catalogue and
// for launching individual slots in demo/real mode).
#[tauri::command]
fn open_url(app: tauri::AppHandle, label: String, url: String, title: String) -> Result<(), String> {
    let mut safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if safe.is_empty() {
        safe = "ext".into();
    }
    if let Some(w) = app.get_webview_window(&safe) {
        let _ = w.set_focus();
        return Ok(());
    }
    let u = tauri::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    // Inject the "Add to Favourites" button only in the OLG catalogue window — not
    // in the per-game demo/real play windows.
    let is_olg = u.host_str().map(|h| h.contains("olg.ca")).unwrap_or(false);
    let is_play = u.path().contains("/casino/play-");
    let is_catalogue = is_olg && !is_play;
    let mut builder = WebviewWindowBuilder::new(&app, &safe, WebviewUrl::External(u))
        .title(&title)
        .inner_size(1120.0, 800.0)
        .min_inner_size(420.0, 520.0)
        .resizable(true)
        .user_agent(DESKTOP_UA);
    if is_catalogue {
        builder = builder.initialization_script(OLG_FAV_SCRIPT);
    } else if is_play {
        // Per-game window → inject the poker-chip pull counter (label baked in so
        // its "Close window" button can target this exact window).
        builder = builder.initialization_script(&COUNTER_SCRIPT.replace("__CSPY_LABEL__", &safe));
    }
    builder
        .build()
        .map_err(|e| format!("window failed: {e}"))?;
    Ok(())
}

// Close a window by label — used by the slot pull-counter's "Close window" button,
// which emits a `slot-close` event the main window relays here (remote pages can't
// close their own native window).
#[tauri::command]
fn close_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    Ok(())
}

#[tauri::command]
fn open_session_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("session") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "session", WebviewUrl::App("session.html".into()))
        .title("Session")
        .inner_size(312.0, 480.0)
        .min_inner_size(280.0, 400.0)
        .position(100.0, 100.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("session window failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_jiffrey(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("jiffrey") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "jiffrey", WebviewUrl::App("chat.html".into()))
        .title("Jiffrey")
        .inner_size(480.0, 660.0)
        .min_inner_size(420.0, 480.0)
        .position(120.0, 120.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("jiffrey window failed: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn chat_reply(prompt: String, model: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let claude = resolve_claude()
            .ok_or_else(|| "Claude Code CLI not found. Install Claude Code or set CLAUDE_CLI_PATH.".to_string())?;
        let dir = std::env::temp_dir();
        run_claude(&claude, &prompt, &model, &dir)
    })
    .await
    .map_err(|e| format!("chat task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("trigger-scan", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(e) = app.global_shortcut().register("CommandOrControl+Shift+B") {
                eprintln!("could not register global shortcut: {e}");
            }
            // Surface the Screen Recording prompt on first launch so the app is
            // registered in the permission list before the first scan.
            if !screen_capture_allowed() {
                let _ = ensure_screen_permission();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan, check_cli, ensure_screen_permission, open_overlay, open_selector, open_slots_data,
            open_session_overlay, open_jiffrey, chat_reply,
            fetch_olg_games, fetch_olg_game, open_url, close_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running CasinoSpy");
}
