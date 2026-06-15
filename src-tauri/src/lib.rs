use image::codecs::png::PngEncoder;
use image::{imageops, ExtendedColorType, ImageEncoder};
use serde::Deserialize;
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

#[tauri::command]
fn open_session_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("session") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "session", WebviewUrl::App("session.html".into()))
        .title("Session")
        .inner_size(290.0, 184.0)
        .min_inner_size(250.0, 150.0)
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
            open_session_overlay, open_jiffrey, chat_reply
        ])
        .run(tauri::generate_context!())
        .expect("error while running CasinoSpy");
}
