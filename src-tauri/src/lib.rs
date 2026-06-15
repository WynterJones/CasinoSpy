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
struct OlgDetail {
    name: String,
    img: String,
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
    // Flatten to RGB — JPEG can't carry an alpha channel.
    let thumb = image::DynamicImage::ImageRgb8(img.thumbnail(360, 360).to_rgb8());
    let mut out = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut out, image::ImageFormat::Jpeg).ok()?;
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
        .and_then(|u| download_thumb(&u))
        .unwrap_or_default();

    Ok(OlgDetail { name, img })
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
  function emitFav(){
    var payload={url:location.href,name:gameName()};
    try{ if(window.__TAURI__&&window.__TAURI__.event&&window.__TAURI__.event.emit){ window.__TAURI__.event.emit('olg-add-fav',payload); return true; } }catch(e){}
    try{ if(window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke){ window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'olg-add-fav',payload:payload}); return true; } }catch(e){}
    return false;
  }
  function sync(){ var b=document.getElementById('cspy-fav'); if(b) b.style.display=onPlay()?'flex':'none'; }
  function mk(){
    if(document.getElementById('cspy-fav')) return;
    var b=document.createElement('button'); b.id='cspy-fav';
    b.innerHTML='★ Add to Favourites';
    b.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;align-items:center;gap:8px;background:linear-gradient(180deg,#f6d26a,#d9a93a);color:#2a1d04;border:1px solid rgba(255,255,255,.4);padding:12px 18px;border-radius:999px;font:800 14px system-ui;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.5)';
    b.onmouseenter=function(){ b.style.filter='brightness(1.06)'; };
    b.onmouseleave=function(){ b.style.filter='none'; };
    b.onclick=function(){ if(emitFav()) toast('✓ Added to CasinoSpy favourites'); else toast('Could not add — try again'); };
    document.body.appendChild(b); sync();
  }
  function boot(){ mk(); }
  if(document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  setTimeout(sync, 1500);
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
    let is_catalogue = is_olg && !u.path().contains("/casino/play-");
    let mut builder = WebviewWindowBuilder::new(&app, &safe, WebviewUrl::External(u))
        .title(&title)
        .inner_size(1120.0, 800.0)
        .min_inner_size(420.0, 520.0)
        .resizable(true)
        .user_agent(DESKTOP_UA);
    if is_catalogue {
        builder = builder.initialization_script(OLG_FAV_SCRIPT);
    }
    builder
        .build()
        .map_err(|e| format!("window failed: {e}"))?;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan, check_cli, open_overlay, open_selector, open_slots_data,
            open_session_overlay, open_jiffrey, chat_reply,
            fetch_olg_games, fetch_olg_game, open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running CasinoSpy");
}
