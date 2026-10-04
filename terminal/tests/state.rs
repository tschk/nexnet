mod common;
use common::*;
use crepuscularity_tui::ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nexnet_term::app::{App, LinkState, Page, StatusKind};
use nexnet_term::protocol::Channel;
use serde_json::Value;

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn ch(app: &mut App, c: char) {
    app.handle_key(key(KeyCode::Char(c)));
}

fn type_str(app: &mut App, s: &str) {
    for c in s.chars() {
        ch(app, c);
    }
}

fn outbox(app: &mut App) -> Vec<Value> {
    app.take_outbox()
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn ok(id: u64, result: &str) -> String {
    format!(r#"{{"id":{id},"ok":true,"result":{result}}}"#)
}

fn err(id: u64, code: &str) -> String {
    format!(r#"{{"id":{id},"ok":false,"error":{{"code":"{code}","message":"server said no"}}}}"#)
}

fn state_event(owner: bool, signed_in: bool) -> String {
    format!(
        r#"{{"event":"state","state":{}}}"#,
        state_json(owner, signed_in)
    )
}

fn msg_event(channel: &str, id: &str, body: &str, at: i64) -> String {
    format!(
        r#"{{"event":"message","channel":"{channel}","message":{}}}"#,
        message_json(id, body, at)
    )
}

fn connected(owner: bool, signed_in: bool) -> App {
    let mut app = App::new(true);
    app.on_link_up();
    app.take_outbox();
    app.on_line(&state_event(owner, signed_in));
    app
}

fn post_id(app: &mut App) -> u64 {
    let sent = outbox(app);
    let post = sent.iter().find(|v| v["cmd"] == "post").expect("post sent");
    post["id"].as_u64().unwrap()
}

#[test]
fn connect_sequence_is_hello_state_history_history_subscribe() {
    let mut app = App::new(true);
    app.on_link_up();
    let sent = outbox(&mut app);
    let cmds: Vec<&str> = sent.iter().map(|v| v["cmd"].as_str().unwrap()).collect();
    assert_eq!(cmds, ["hello", "state", "history", "history", "subscribe"]);
    assert_eq!(sent[0]["protocol"], 1);
    assert_eq!(sent[2]["channel"], "updates");
    assert_eq!(sent[2]["limit"], 50);
    assert_eq!(sent[3]["channel"], "public");
    assert_eq!(
        sent[4]["channels"],
        serde_json::json!(["updates", "public"])
    );
    let ids: Vec<u64> = sent.iter().map(|v| v["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [1, 2, 3, 4, 5]);
}

#[test]
fn page_switching() {
    let mut app = connected(false, false);
    assert_eq!(app.page, Page::Public);
    ch(&mut app, '1');
    assert_eq!(app.page, Page::Updates);
    ch(&mut app, '3');
    assert_eq!(app.page, Page::Identity);
    ch(&mut app, '2');
    assert_eq!(app.page, Page::Public);
    app.handle_key(key(KeyCode::Tab));
    assert_eq!(app.page, Page::Identity);
    app.handle_key(key(KeyCode::Tab));
    assert_eq!(app.page, Page::Updates);
    app.handle_key(key(KeyCode::Tab));
    assert_eq!(app.page, Page::Public);
    app.handle_key(key(KeyCode::BackTab));
    assert_eq!(app.page, Page::Updates);
}

#[test]
fn q_quits_outside_editor_and_is_text_inside() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    assert!(app.editing);
    type_str(&mut app, "quit 1 2 3 q");
    assert!(!app.quit);
    assert_eq!(app.page, Page::Public);
    assert_eq!(app.draft(Channel::Public).text, "quit 1 2 3 q");
    app.handle_key(key(KeyCode::Esc));
    assert!(!app.editing);
    ch(&mut app, 'q');
    assert!(app.quit);
}

#[test]
fn ctrl_c_quits_anywhere() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.quit);
}

#[test]
fn enter_and_e_open_editor_and_esc_keeps_draft() {
    let mut app = connected(false, true);
    app.handle_key(key(KeyCode::Enter));
    assert!(app.editing);
    type_str(&mut app, "draft");
    app.handle_key(key(KeyCode::Esc));
    assert!(!app.editing);
    assert_eq!(app.draft(Channel::Public).text, "draft");
    ch(&mut app, 'e');
    assert!(app.editing);
    assert_eq!(app.draft(Channel::Public).cursor, 5);
    assert!(outbox(&mut app).is_empty());
}

#[test]
fn utf8_cursor_editing() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    type_str(&mut app, "aé日😀b");
    let d = |app: &App| app.draft(Channel::Public).clone();
    assert_eq!(d(&app).cursor, "aé日😀b".len());
    app.handle_key(key(KeyCode::Left));
    app.handle_key(key(KeyCode::Left));
    assert_eq!(d(&app).cursor, "aé日".len());
    app.handle_key(key(KeyCode::Backspace));
    assert_eq!(d(&app).text, "aé😀b");
    app.handle_key(key(KeyCode::Delete));
    assert_eq!(d(&app).text, "aéb");
    app.handle_key(key(KeyCode::Home));
    assert_eq!(d(&app).cursor, 0);
    app.handle_key(key(KeyCode::Backspace));
    app.handle_key(key(KeyCode::Left));
    assert_eq!(d(&app).text, "aéb");
    app.handle_key(key(KeyCode::Right));
    app.handle_key(key(KeyCode::Right));
    assert_eq!(d(&app).cursor, "aé".len());
    ch(&mut app, 'ü');
    assert_eq!(d(&app).text, "aéüb");
    app.handle_key(key(KeyCode::End));
    app.handle_key(key(KeyCode::Right));
    app.handle_key(key(KeyCode::Delete));
    assert_eq!(d(&app).text, "aéüb");
    assert!(d(&app).text.is_char_boundary(d(&app).cursor));
}

#[test]
fn byte_cap_is_enforced_on_characters() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    for _ in 0..1999 {
        ch(&mut app, 'a');
    }
    ch(&mut app, 'é');
    assert_eq!(app.draft(Channel::Public).text.len(), 1999);
    assert_eq!(app.status.kind, StatusKind::Error);
    assert!(app.status.text.contains("2000"));
    ch(&mut app, 'a');
    assert_eq!(app.draft(Channel::Public).text.len(), 2000);
    ch(&mut app, 'a');
    assert_eq!(app.draft(Channel::Public).text.len(), 2000);
    let out = render(&mut app, 80, 24);
    assert!(out.contains("2000/2000"), "{out}");
}

#[test]
fn signed_out_post_does_not_fail_silently() {
    let mut app = connected(false, false);
    ch(&mut app, 'e');
    type_str(&mut app, "hello");
    app.handle_key(key(KeyCode::Enter));
    assert!(outbox(&mut app).is_empty());
    assert_eq!(app.status.kind, StatusKind::Error);
    assert!(
        app.status.text.contains("Identity (3)"),
        "{}",
        app.status.text
    );
    assert!(app.status.text.contains("sign in"));
    assert_eq!(app.draft(Channel::Public).text, "hello");
}

#[test]
fn empty_draft_is_not_posted() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    type_str(&mut app, "   ");
    app.handle_key(key(KeyCode::Enter));
    assert!(outbox(&mut app).is_empty());
}

#[test]
fn successful_post_clears_draft_and_shows_message() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    type_str(&mut app, "hi there");
    app.handle_key(key(KeyCode::Enter));
    let id = post_id(&mut app);
    assert_eq!(app.status.text, "posting");
    app.on_line(&ok(
        id,
        &format!(
            r#"{{"message":{}}}"#,
            message_json("p1", "hi there", 1_790_000_000_000)
        ),
    ));
    assert_eq!(app.draft(Channel::Public).text, "");
    assert_eq!(app.channels[Channel::Public.index()].messages.len(), 1);
    assert_eq!(app.status.kind, StatusKind::Ok);
    let out = render(&mut app, 80, 24);
    assert!(out.contains("hi there"), "{out}");
}

#[test]
fn pushed_event_and_response_dedupe_by_id_in_either_order() {
    for event_first in [true, false] {
        let mut app = connected(false, true);
        ch(&mut app, 'e');
        type_str(&mut app, "once");
        app.handle_key(key(KeyCode::Enter));
        let id = post_id(&mut app);
        let event = msg_event("public", "dup", "once", 100);
        let resp = ok(
            id,
            &format!(r#"{{"message":{}}}"#, message_json("dup", "once", 100)),
        );
        if event_first {
            app.on_line(&event);
            app.on_line(&resp);
        } else {
            app.on_line(&resp);
            app.on_line(&event);
        }
        assert_eq!(app.channels[Channel::Public.index()].messages.len(), 1);
        assert_eq!(app.draft(Channel::Public).text, "");
    }
}

#[test]
fn draft_is_retained_on_every_error_code() {
    for (code, needle) in [
        ("rate_limited", "rate limited"),
        ("forbidden", "not allowed"),
        ("revoked", "revoked"),
        ("unauthenticated", "not signed in"),
        ("offline", "offline"),
        ("unconfigured", "no gateway"),
        ("invalid", "invalid"),
        ("internal", "agent error"),
        ("mystery", "mystery"),
    ] {
        let mut app = connected(false, true);
        ch(&mut app, 'e');
        type_str(&mut app, "keep me");
        app.handle_key(key(KeyCode::Enter));
        let id = post_id(&mut app);
        app.on_line(&err(id, code));
        assert_eq!(app.draft(Channel::Public).text, "keep me", "{code}");
        assert_eq!(app.status.kind, StatusKind::Error, "{code}");
        assert!(
            app.status.text.contains(needle),
            "{code}: {}",
            app.status.text
        );
        assert!(app.status.text.contains("draft kept"), "{code}");
        assert!(app.channels[Channel::Public.index()].messages.is_empty());
        assert!(!app.post_in_flight());
        app.handle_key(key(KeyCode::Enter));
        assert!(!outbox(&mut app).is_empty(), "retry sends again for {code}");
    }
}

#[test]
fn error_event_sets_status() {
    let mut app = connected(false, false);
    app.on_line(r#"{"event":"error","code":"offline","message":"gw down"}"#);
    assert_eq!(app.status.kind, StatusKind::Error);
    assert!(app.status.text.contains("offline"));
}

#[test]
fn updates_editor_is_owner_only() {
    let mut app = connected(false, true);
    ch(&mut app, '1');
    ch(&mut app, 'e');
    assert!(!app.editing);
    assert!(app.status.text.contains("read-only"));
    app.handle_key(key(KeyCode::Enter));
    assert!(!app.editing);
    let out = render(&mut app, 80, 24);
    assert!(out.contains("updates is read-only"), "{out}");

    app.on_line(&state_event(true, true));
    ch(&mut app, 'e');
    assert!(app.editing);
    type_str(&mut app, "release notes");
    app.handle_key(key(KeyCode::Enter));
    let sent = outbox(&mut app);
    let post = sent.iter().find(|v| v["cmd"] == "post").unwrap();
    assert_eq!(post["channel"], "updates");
    assert_eq!(post["body"], "release notes");
    assert_eq!(app.draft(Channel::Public).text, "");
    assert_eq!(app.draft(Channel::Updates).text, "release notes");
}

#[test]
fn losing_owner_closes_updates_editor() {
    let mut app = connected(true, true);
    ch(&mut app, '1');
    ch(&mut app, 'e');
    assert!(app.editing);
    app.on_line(&state_event(false, true));
    assert!(!app.editing);
}

#[test]
fn history_merges_sorted_and_deduped() {
    let mut app = App::new(true);
    app.on_link_up();
    let sent = outbox(&mut app);
    let hid = sent[3]["id"].as_u64().unwrap();
    app.on_line(&msg_event("public", "b", "second", 200));
    let history = format!(
        r#"{{"channel":"public","messages":[{},{},{}]}}"#,
        message_json("a", "first", 100),
        message_json("b", "second", 200),
        message_json("c", "third", 300)
    );
    app.on_line(&ok(hid, &history));
    let ids: Vec<&str> = app.channels[1]
        .messages
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    assert_eq!(ids, ["a", "b", "c"]);
    assert!(app.channels[1].loaded);
    assert!(app.channels[0].messages.is_empty());
}

#[test]
fn history_error_marks_loaded_and_reports() {
    let mut app = App::new(true);
    app.on_link_up();
    let sent = outbox(&mut app);
    app.on_line(&err(sent[2]["id"].as_u64().unwrap(), "offline"));
    assert!(app.channels[0].loaded);
    assert!(app.status.text.contains("history unavailable"));
}

#[test]
fn scrolling_keys() {
    let mut app = connected(false, false);
    for i in 0..40 {
        app.on_line(&msg_event(
            "public",
            &format!("m{i}"),
            &format!("message {i}"),
            i,
        ));
    }
    let _ = render(&mut app, 80, 24);
    let s = |app: &App| app.channels[1].scroll;
    assert_eq!(s(&app), 0);
    app.handle_key(key(KeyCode::Up));
    assert_eq!(s(&app), 1);
    app.handle_key(key(KeyCode::Down));
    assert_eq!(s(&app), 0);
    app.handle_key(key(KeyCode::Down));
    assert_eq!(s(&app), 0);
    app.handle_key(key(KeyCode::PageUp));
    assert_eq!(s(&app), 19);
    app.handle_key(key(KeyCode::PageDown));
    assert_eq!(s(&app), 0);
    app.handle_key(key(KeyCode::Home));
    let out = render(&mut app, 80, 24);
    assert!(out.contains("message 0"), "{out}");
    assert!(!out.contains("message 39"), "{out}");
    assert!(s(&app) <= 80 * 2);
    app.handle_key(key(KeyCode::End));
    let out = render(&mut app, 80, 24);
    assert!(out.contains("message 39"), "{out}");
}

#[test]
fn new_messages_do_not_shift_a_scrolled_view() {
    let mut app = connected(false, false);
    for i in 0..40 {
        app.on_line(&msg_event(
            "public",
            &format!("m{i}"),
            &format!("message {i}"),
            i,
        ));
    }
    let _ = render(&mut app, 80, 24);
    app.handle_key(key(KeyCode::PageUp));
    let before = render(&mut app, 80, 24);
    app.on_line(&msg_event("public", "new", "brand new", 1000));
    let after = render(&mut app, 80, 24);
    assert_eq!(before, after);
    assert!(!after.contains("brand new"));
}

#[test]
fn identity_actions() {
    let mut app = App::new(true);
    app.on_link_up();
    outbox(&mut app);
    app.on_line(&hello_line(1));
    app.on_line(
        r#"{"event":"state","state":{"gateway":{"status":"online"},"identity":null,"session":null,"owner":false}}"#,
    );
    ch(&mut app, '3');
    ch(&mut app, 'c');
    let sent = outbox(&mut app);
    assert_eq!(sent[0]["cmd"], "identity.create");
    let id = sent[0]["id"].as_u64().unwrap();
    app.on_line(&ok(id, &state_json(false, false)));
    assert!(app.status.text.contains("identity created"));
    ch(&mut app, 'c');
    assert!(outbox(&mut app).is_empty());
    assert!(app.status.text.contains("already"));

    assert_eq!(app.selected_method().as_deref(), Some("wallet"));
    ch(&mut app, 's');
    assert_eq!(app.selected_method().as_deref(), Some("ssh"));
    ch(&mut app, 's');
    assert_eq!(app.selected_method().as_deref(), Some("wallet"));
    ch(&mut app, 's');
    app.handle_key(key(KeyCode::Enter));
    let sent = outbox(&mut app);
    assert_eq!(sent[0]["cmd"], "signin");
    assert_eq!(sent[0]["method"], "ssh");
    app.on_line(&ok(
        sent[0]["id"].as_u64().unwrap(),
        &state_json(false, true),
    ));
    assert!(app.signed_in());
    assert!(app.status.text.contains("signed in"));

    ch(&mut app, 'o');
    let sent = outbox(&mut app);
    assert_eq!(sent[0]["cmd"], "signout");
    app.on_line(&ok(
        sent[0]["id"].as_u64().unwrap(),
        &state_json(false, false),
    ));
    assert!(!app.signed_in());
    ch(&mut app, 'o');
    assert!(outbox(&mut app).is_empty());
    assert!(app.status.text.contains("not signed in"));
}

#[test]
fn signin_error_is_reported() {
    let mut app = connected(false, false);
    app.on_line(&ok(1, r#"{"agent":"m","protocol":1,"methods":["wallet"]}"#));
    outbox(&mut app);
    app.on_line(&hello_line(1));
    ch(&mut app, '3');
    app.handle_key(key(KeyCode::Enter));
    let sent = outbox(&mut app);
    assert_eq!(sent[0]["method"], "wallet");
    app.on_line(&err(sent[0]["id"].as_u64().unwrap(), "forbidden"));
    assert!(app.status.text.contains("sign-in failed"));
}

#[test]
fn identity_page_ignores_chat_keys() {
    let mut app = connected(false, true);
    ch(&mut app, '3');
    ch(&mut app, 'e');
    assert!(!app.editing);
    app.handle_key(key(KeyCode::Enter));
    assert!(!app.editing);
}

#[test]
fn malformed_lines_are_counted_and_skipped() {
    let mut app = connected(false, false);
    for bad in ["", "garbage", "{", "[]", r#"{"id":1}"#, "\u{0}\u{1}"] {
        app.on_line(bad);
    }
    app.on_malformed();
    assert_eq!(app.malformed, 7);
    app.on_line(&msg_event("public", "ok", "still works", 1));
    assert_eq!(app.channels[1].messages.len(), 1);
    let out = render(&mut app, 80, 24);
    assert!(out.contains("skipped 7"), "{out}");
}

#[test]
fn unknown_response_ids_are_ignored() {
    let mut app = connected(false, false);
    app.on_line(&ok(999, "{}"));
    app.on_line(&err(998, "internal"));
    assert_eq!(app.malformed, 0);
}

#[test]
fn disconnect_keeps_draft_and_blocks_post() {
    let mut app = connected(false, true);
    ch(&mut app, 'e');
    type_str(&mut app, "important");
    app.on_link_down("agent exited", Some(500));
    assert!(matches!(app.link, LinkState::Disconnected { .. }));
    app.handle_key(key(KeyCode::Enter));
    assert!(outbox(&mut app).is_empty());
    assert!(app.status.text.contains("draft kept"));
    assert_eq!(app.draft(Channel::Public).text, "important");
    app.on_link_up();
    assert_eq!(app.draft(Channel::Public).text, "important");
    assert!(app.editing);
    assert_eq!(outbox(&mut app).len(), 5);
}

#[test]
fn unconfigured_has_no_chat() {
    let mut app = App::new(false);
    assert_eq!(app.link, LinkState::Unconfigured);
    ch(&mut app, 'e');
    assert!(!app.editing);
    assert!(app.status.text.contains("no agent configured"));
    ch(&mut app, '3');
    ch(&mut app, 'c');
    assert!(app.take_outbox().is_empty());
    let out = render(&mut app, 80, 24);
    assert!(out.contains("no agent"), "{out}");
}

#[test]
fn hello_protocol_mismatch_is_reported() {
    let mut app = App::new(true);
    app.on_link_up();
    let id = outbox(&mut app)[0]["id"].as_u64().unwrap();
    app.on_line(&ok(id, r#"{"agent":"x","protocol":2,"methods":[]}"#));
    assert!(app.status.text.contains("protocol 2"));
}

#[test]
fn agent_text_cannot_inject_terminal_escapes() {
    let mut app = connected(false, false);
    app.on_line(&msg_event(
        "public",
        "e",
        "hi \u{1b}[2J\u{1b}]0;pwn\u{7} there",
        1,
    ));
    app.on_line(r#"{"event":"error","code":"offline","message":"\u001b[31mred"}"#);
    let out = render(&mut app, 80, 24);
    assert!(!out.contains('\u{1b}'));
    assert!(out.contains("hi [2J]0;pwn there"), "{out}");
}
