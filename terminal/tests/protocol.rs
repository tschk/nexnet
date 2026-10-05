use nexnet_term::protocol::*;
use serde_json::{json, Value};

fn line(req: &Request, id: u64) -> Value {
    serde_json::from_str(&req.to_line(id)).unwrap()
}

#[test]
fn serialises_every_request() {
    assert_eq!(
        line(&Request::Hello { protocol: 1 }, 1),
        json!({"id": 1, "cmd": "hello", "protocol": 1})
    );
    assert_eq!(line(&Request::State, 2), json!({"id": 2, "cmd": "state"}));
    assert_eq!(
        line(&Request::IdentityCreate, 3),
        json!({"id": 3, "cmd": "identity.create"})
    );
    assert_eq!(
        line(
            &Request::Signin {
                method: "wallet".into()
            },
            4
        ),
        json!({"id": 4, "cmd": "signin", "method": "wallet"})
    );
    assert_eq!(
        line(&Request::Signout, 5),
        json!({"id": 5, "cmd": "signout"})
    );
    assert_eq!(
        line(
            &Request::History {
                channel: Channel::Public,
                limit: 50
            },
            6
        ),
        json!({"id": 6, "cmd": "history", "channel": "public", "limit": 50})
    );
    assert_eq!(
        line(
            &Request::Post {
                channel: Channel::Public,
                body: "text".into()
            },
            7
        ),
        json!({"id": 7, "cmd": "post", "channel": "public", "body": "text"})
    );
    assert_eq!(
        line(
            &Request::Subscribe {
                channels: vec![Channel::Updates, Channel::Public]
            },
            8
        ),
        json!({"id": 8, "cmd": "subscribe", "channels": ["updates", "public"]})
    );
}

#[test]
fn request_lines_are_single_line_utf8() {
    let l = Request::Post {
        channel: Channel::Updates,
        body: "multi\nline \"quoted\" 日本語 \u{1F600}".into(),
    }
    .to_line(9);
    assert!(!l.contains('\n'));
    let v: Value = serde_json::from_str(&l).unwrap();
    assert_eq!(v["body"], "multi\nline \"quoted\" 日本語 \u{1F600}");
    assert_eq!(v["channel"], "updates");
}

#[test]
fn field_order_puts_id_then_cmd() {
    let l = Request::State.to_line(2);
    assert_eq!(l, r#"{"id":2,"cmd":"state"}"#);
}

#[test]
fn parses_ok_response() {
    let r = parse_incoming(r#"{"id": 1, "ok": true, "result": {}}"#).unwrap();
    assert_eq!(
        r,
        Incoming::Response {
            id: 1,
            outcome: Ok(json!({}))
        }
    );
}

#[test]
fn parses_every_error_code() {
    let codes = [
        ("unconfigured", ErrorCode::Unconfigured),
        ("offline", ErrorCode::Offline),
        ("unauthenticated", ErrorCode::Unauthenticated),
        ("forbidden", ErrorCode::Forbidden),
        ("revoked", ErrorCode::Revoked),
        ("rate_limited", ErrorCode::RateLimited),
        ("invalid", ErrorCode::Invalid),
        ("internal", ErrorCode::Internal),
    ];
    for (name, code) in codes {
        let l =
            format!(r#"{{"id": 7, "ok": false, "error": {{"code": "{name}", "message": "m"}}}}"#);
        match parse_incoming(&l).unwrap() {
            Incoming::Response {
                id: 7,
                outcome: Err(e),
            } => {
                assert_eq!(e.code, code);
                assert_eq!(e.code.as_str(), name);
                assert_eq!(e.message, "m");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let l = r#"{"id": 7, "ok": false, "error": {"code": "weird", "message": "m"}}"#;
    match parse_incoming(l).unwrap() {
        Incoming::Response {
            outcome: Err(e), ..
        } => {
            assert_eq!(e.code, ErrorCode::Other("weird".into()));
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn parses_hello_state_history_post_results() {
    let hello: Hello =
        decode(&json!({"agent": "name", "protocol": 1, "methods": ["wallet", "ssh"]})).unwrap();
    assert_eq!(hello.agent, "name");
    assert_eq!(hello.protocol, 1);
    assert_eq!(hello.methods, vec!["wallet", "ssh"]);

    let state: State = decode(&json!({
        "gateway": {"status": "online", "url": "https://x"},
        "identity": {"id": "ab", "short": "nx1abcd…wxyz", "username": null},
        "session": {"method": "ssh", "expiresAt": 1790000000000i64},
        "owner": false
    }))
    .unwrap();
    assert_eq!(state.gateway.status, "online");
    assert_eq!(state.identity.as_ref().unwrap().username, None);
    assert_eq!(
        state.session.as_ref().unwrap().expires_at,
        Some(1790000000000)
    );
    assert!(!state.owner);

    let empty: State = decode(&json!({
        "gateway": {"status": "unconfigured"},
        "identity": null,
        "session": null,
        "owner": true
    }))
    .unwrap();
    assert!(empty.identity.is_none() && empty.session.is_none() && empty.owner);

    let msg = json!({"id": "m", "author": {"id": "a", "short": "s", "username": "u"}, "body": "hi", "at": 5});
    let hist: History = decode(&json!({"channel": "public", "messages": [msg.clone()]})).unwrap();
    assert_eq!(hist.channel, Channel::Public);
    assert_eq!(hist.messages[0].author.username.as_deref(), Some("u"));
    let posted: Posted = decode(&json!({"message": msg})).unwrap();
    assert_eq!(posted.message.body, "hi");
}

#[test]
fn parses_events() {
    let msg = r#"{"id":"m","author":{"id":"a","short":"s","username":null},"body":"hi","at":5}"#;
    let l = format!(r#"{{"event":"message","channel":"updates","message":{msg}}}"#);
    match parse_incoming(&l).unwrap() {
        Incoming::Event(Event::Message { channel, message }) => {
            assert_eq!(channel, Channel::Updates);
            assert_eq!(message.id, "m");
        }
        other => panic!("unexpected {other:?}"),
    }
    let l = r#"{"event":"state","state":{"gateway":{"status":"offline"},"identity":null,"session":null,"owner":false}}"#;
    assert!(matches!(
        parse_incoming(l).unwrap(),
        Incoming::Event(Event::State(_))
    ));
    let l = r#"{"event":"error","code":"offline","message":"gateway down"}"#;
    assert_eq!(
        parse_incoming(l).unwrap(),
        Incoming::Event(Event::Error {
            code: ErrorCode::Offline,
            message: "gateway down".into()
        })
    );
    assert_eq!(
        parse_incoming(r#"{"event":"future-thing"}"#).unwrap(),
        Incoming::Event(Event::Unknown)
    );
}

#[test]
fn rejects_malformed_lines() {
    let bad = [
        "",
        "not json",
        "[]",
        "42",
        r#"{"id": 1}"#,
        r#"{"ok": true}"#,
        r#"{"id": "x", "ok": true}"#,
        r#"{"id": 1, "ok": false}"#,
        r#"{"id": 1, "ok": false, "error": {"message": "no code"}}"#,
        r#"{"event": 5}"#,
        r#"{"event": "message", "channel": "bogus", "message": {}}"#,
        r#"{"event": "message", "channel": "public"}"#,
        r#"{"event": "state"}"#,
        r#"{"event": "error"}"#,
    ];
    for b in bad {
        assert!(parse_incoming(b).is_err(), "should reject {b:?}");
    }
}

#[test]
fn rejects_oversize_line() {
    let big = format!(
        r#"{{"id":1,"ok":true,"result":"{}"}}"#,
        "x".repeat(MAX_LINE_BYTES)
    );
    assert!(parse_incoming(&big).is_err());
}

#[test]
fn constants_match_the_spec() {
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(MAX_LINE_BYTES, 65536);
    assert_eq!(MAX_BODY_BYTES, 2000);
    assert_eq!(HISTORY_LIMIT, 50);
    assert_eq!(SERIAL_PREFIX, "@@nexnet ");
}
