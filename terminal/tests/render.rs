mod common;
use common::*;
use crepuscularity_tui::ratatui::backend::TestBackend;
use crepuscularity_tui::ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use crepuscularity_tui::ratatui::Terminal;
use nexnet_term::app::{App, Page};
use nexnet_term::view::{ColorMode, View};

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn live_app(owner: bool, signed_in: bool) -> App {
    let mut app = App::new(true);
    app.on_link_up();
    app.take_outbox();
    app.on_line(&hello_line(1));
    app.on_line(&format!(
        r#"{{"event":"state","state":{}}}"#,
        state_json(owner, signed_in)
    ));
    app.on_line(&format!(
        r#"{{"event":"message","channel":"public","message":{}}}"#,
        message_json(
            "m1",
            "hello {rows} wrapped message that is long enough to need more than one line at forty columns",
            1_790_000_000_000
        )
    ));
    app
}

fn lines(s: &str) -> Vec<&str> {
    s.lines().collect()
}

#[test]
fn public_page_80x24() {
    let mut app = live_app(false, true);
    let out = render(&mut app, 80, 24);
    let l = lines(&out);
    assert_eq!(l.len(), 24);
    assert!(l[0].contains("nexnet"));
    assert!(l[0].contains("1 updates"));
    assert!(l[0].contains("[2 public]"));
    assert!(l[0].contains("3 identity"));
    assert!(l[0].contains("connected"));
    assert!(out.contains("14:13 alice"), "{out}");
    assert!(out.contains("nx1abcd…wxyz"));
    assert!(out.contains("{rows}"));
    assert!(l[21].contains("press e or Enter to write"), "{out}");
    assert!(l[22].contains("q quit"));
    assert!(l[23].contains("connected"));
    let body_start = l.iter().position(|x| x.contains("14:13")).unwrap();
    assert!(body_start >= 16, "newest messages hug the bottom: {out}");
}

#[test]
fn updates_page_80x24_read_only() {
    let mut app = live_app(false, false);
    app.handle_key(key(KeyCode::Char('1')));
    let out = render(&mut app, 80, 24);
    assert!(out.contains("[1 updates]"));
    assert!(out.contains("updates is read-only"));
    assert!(out.contains("no messages in updates yet") || out.contains("loading history"));
    assert!(!out.contains("e write"));
}

#[test]
fn updates_page_owner_shows_badge_and_editor_hint() {
    let mut app = live_app(true, true);
    app.handle_key(key(KeyCode::Char('1')));
    let out = render(&mut app, 80, 24);
    assert!(out.contains("[owner]"));
    assert!(out.contains("press e or Enter to write"));
    assert!(out.contains("e write"));
}

#[test]
fn editor_shows_prompt_cursor_and_counter() {
    let mut app = live_app(false, true);
    app.handle_key(key(KeyCode::Char('e')));
    for c in "héllo".chars() {
        app.handle_key(key(KeyCode::Char(c)));
    }
    app.handle_key(key(KeyCode::Left));
    let out = render(&mut app, 80, 24);
    let l = lines(&out);
    assert!(l[21].starts_with("> héll"), "{out}");
    assert!(l[21].contains("6/2000"), "{out}");
    assert!(l[22].contains("Enter send"));
    assert!(l[22].contains("Esc"));
}

#[test]
fn identity_page_80x24_signed_in() {
    let mut app = live_app(true, true);
    app.handle_key(key(KeyCode::Char('3')));
    let out = render(&mut app, 80, 24);
    for needle in [
        "[3 identity]",
        "gateway",
        "online",
        "https://gw.example",
        "mock (protocol 1)",
        "nx1abcd…wxyz [owner]",
        "none",
        "ssh, expires 2026-09-21 14:13 UTC",
        "[wallet]  ssh",
        "create identity",
        "select sign-in method",
        "sign out",
        "c create  s method  Enter sign in  o sign out",
    ] {
        assert!(out.contains(needle), "missing {needle:?}\n{out}");
    }
    assert!(!out.contains("e write"));
}

#[test]
fn identity_page_signed_out_without_identity() {
    let mut app = App::new(true);
    app.on_link_up();
    app.take_outbox();
    app.on_line(r#"{"event":"state","state":{"gateway":{"status":"unconfigured"},"identity":null,"session":null,"owner":false}}"#);
    app.page = Page::Identity;
    let out = render(&mut app, 80, 24);
    assert!(out.contains("unconfigured"));
    assert!(out.contains("signed out"));
    assert!(out.matches("none").count() >= 2, "{out}");
    assert!(!out.contains("[owner]"));
}

#[test]
fn never_shows_secrets() {
    let mut app = live_app(false, true);
    app.on_line(r#"{"event":"state","state":{"gateway":{"status":"online"},"identity":{"id":"aa","short":"nx1abcd…wxyz","username":null,"secret":"TOPSECRET"},"session":{"method":"ssh","expiresAt":1,"token":"TOKENVALUE"},"owner":false}}"#);
    app.page = Page::Identity;
    let out = render(&mut app, 80, 24);
    assert!(!out.contains("TOPSECRET") && !out.contains("TOKENVALUE"));
}

#[test]
fn tiny_40x12_all_pages() {
    let mut app = live_app(true, true);
    app.handle_key(key(KeyCode::Char('2')));
    let out = render(&mut app, 40, 12);
    assert_eq!(lines(&out).len(), 12);
    assert!(out.contains("[2 pub]"), "{out}");
    assert!(out.contains("1 upd"));
    assert!(out.contains("3 id"));
    assert!(out.contains("alice"));
    assert!(out.contains("connected"));
    app.handle_key(key(KeyCode::Char('1')));
    let out = render(&mut app, 40, 12);
    assert!(out.contains("[1 upd]"), "{out}");
    app.handle_key(key(KeyCode::Char('3')));
    let out = render(&mut app, 40, 12);
    assert!(out.contains("[3 id]"), "{out}");
    assert!(out.contains("gateway"));
    assert!(out.contains("identity"));
    for l in lines(&out) {
        assert!(l.chars().count() <= 40);
    }
}

#[test]
fn no_panic_on_degenerate_areas() {
    for (w, h) in [
        (0, 0),
        (1, 1),
        (2, 1),
        (5, 2),
        (10, 3),
        (3, 30),
        (200, 2),
        (40, 4),
        (40, 5),
    ] {
        for page in [Page::Updates, Page::Public, Page::Identity] {
            for editing in [false, true] {
                let mut app = live_app(true, true);
                app.page = page;
                app.editing = editing && page != Page::Identity;
                let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
                let view = View::new(ColorMode::Rgb);
                terminal.draw(|f| view.draw(f, &mut app)).unwrap();
            }
        }
    }
}

#[test]
fn unconfigured_shows_disabled_state_not_fake_chat() {
    let mut app = App::new(false);
    let out = render(&mut app, 80, 24);
    assert!(out.contains("no agent configured"));
    assert!(out.contains("reading and posting are disabled"));
    assert!(out.contains("--agent"));
    assert!(out.contains("--serial"));
    assert!(!out.contains("alice"));
    let small = render(&mut app, 40, 12);
    assert!(small.contains("no agent"));
}

#[test]
fn disconnected_banner_and_retry_countdown() {
    let mut app = live_app(false, true);
    app.on_link_down("agent exited: boom", Some(4000));
    let out = render(&mut app, 80, 24);
    assert!(out.contains("disconnected (retry 4s)"), "{out}");
    assert!(out.contains("disconnected: agent exited: boom"));
    assert!(out.contains("alice"), "cached messages stay visible");
}

#[test]
fn wide_characters_stay_within_the_pane() {
    let mut app = live_app(false, true);
    app.on_line(&format!(
        r#"{{"event":"message","channel":"public","message":{}}}"#,
        message_json("w", &"日本語のテキスト".repeat(10), 1_790_000_100_000)
    ));
    let out = render(&mut app, 40, 12);
    assert!(out.contains("日本語"));
    for l in out.lines() {
        assert!(unicode_width::UnicodeWidthStr::width(l) <= 40, "{l:?}");
    }
}

#[test]
fn ansi16_palette_replaces_every_rgb_literal() {
    let src = nexnet_term::view::template_source(ColorMode::Ansi16);
    assert!(!src.contains("#10131c") && !src.contains("#d8dbe2"));
    assert!(!src.contains("[#"));
    assert!(src.contains("bg-[ansi-0]"));
    let rgb = nexnet_term::view::template_source(ColorMode::Rgb);
    assert!(rgb.contains("bg-[#10131c]") && rgb.contains("text-[#d8dbe2]"));
    for hex in [
        "#8890a0", "#ff8888", "#a8d68a", "#f0c674", "#7ea6e8", "#d8a8e8",
    ] {
        assert!(rgb.contains(hex), "{hex}");
    }
    let mut app = live_app(false, true);
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    let view = View::new(ColorMode::Ansi16);
    terminal.draw(|f| view.draw(f, &mut app)).unwrap();
    let text: String = (0..80)
        .map(|x| terminal.backend().buffer()[(x, 0)].symbol().to_string())
        .collect();
    assert!(text.contains("[2 public]"));
}

#[test]
fn rgb_theme_colors_reach_the_buffer() {
    use crepuscularity_tui::ratatui::style::Color;
    let mut app = live_app(false, true);
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    let view = View::new(ColorMode::Rgb);
    terminal.draw(|f| view.draw(f, &mut app)).unwrap();
    let buf = terminal.backend().buffer();
    assert_eq!(buf[(0, 5)].bg, Color::Rgb(0x10, 0x13, 0x1c));
    let tab_cell = (0..80)
        .map(|x| &buf[(x, 0)])
        .find(|c| c.symbol() == "[")
        .unwrap();
    assert_eq!(tab_cell.bg, Color::Rgb(0x7e, 0xa6, 0xe8));
}
