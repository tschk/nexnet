mod common;
use common::*;
use crepuscularity_tui::ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nexnet_term::app::{App, LinkState};
use nexnet_term::conn::Connection;
use nexnet_term::link::Transport;
use nexnet_term::protocol::{Channel, SERIAL_PREFIX};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn type_str(app: &mut App, s: &str) {
    for c in s.chars() {
        app.handle_key(key(KeyCode::Char(c)));
    }
}

fn pump_until(
    conn: &mut Connection,
    app: &mut App,
    secs: u64,
    cond: impl Fn(&App) -> bool,
) -> bool {
    let start = Instant::now();
    loop {
        conn.pump(app, Instant::now());
        if cond(app) {
            return true;
        }
        if start.elapsed() > Duration::from_secs(secs) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexnet-term-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn agent_script(dir: &std::path::Path, exit_after_subscribe: bool) -> Vec<String> {
    let state = state_json(false, true);
    let m1 = message_json("h1", "history one", 1_790_000_000_000);
    let m2 = message_json("h2", "history two", 1_790_000_001_000);
    let u1 = message_json("u1", "release notes", 1_790_000_002_000);
    let pushed = message_json("push1", "pushed after subscribe", 1_790_000_003_000);
    let exit = if exit_after_subscribe {
        "echo 'boom stderr' >&2; exit 3"
    } else {
        ":"
    };
    let script = format!(
        r#"
echo started >> '{count}'
echo $$ > '{pid}'
STATE='{state}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{{"id":\([0-9][0-9]*\),.*/\1/p')
  case "$line" in
    *'"cmd":"hello"'*)
      echo 'this is not json'
      printf '\377\376 invalid utf8\n'
      head -c 70000 /dev/zero | tr '\0' x; echo
      printf '{{"id":%s,"ok":true,"result":{{"agent":"mock","protocol":1,"methods":["wallet","ssh"]}}}}\n' "$id" ;;
    *'"cmd":"state"'*)
      printf '{{"id":%s,"ok":true,"result":%s}}\n' "$id" "$STATE" ;;
    *'"cmd":"history"'*'"channel":"public"'*)
      printf '{{"id":%s,"ok":true,"result":{{"channel":"public","messages":[{m1},{m2}]}}}}\n' "$id" ;;
    *'"cmd":"history"'*)
      printf '{{"id":%s,"ok":true,"result":{{"channel":"updates","messages":[{u1}]}}}}\n' "$id" ;;
    *'"cmd":"subscribe"'*)
      printf '{{"id":%s,"ok":true,"result":{{}}}}\n' "$id"
      printf '{{"event":"message","channel":"public","message":{pushed}}}\n'
      {exit} ;;
    *'"cmd":"post"'*)
      body=$(printf '%s' "$line" | sed -n 's/.*"body":"\([^"]*\)".*/\1/p')
      msg=$(printf '{{"id":"posted1","author":{author},"body":"%s","at":1790000009000}}' "$body")
      printf '{{"id":%s,"ok":true,"result":{{"message":%s}}}}\n' "$id" "$msg"
      printf '{{"event":"message","channel":"public","message":%s}}\n' "$msg" ;;
  esac
done
"#,
        count = dir.join("count").display(),
        pid = dir.join("pid").display(),
        author = AUTHOR,
    );
    vec!["sh".into(), "-c".into(), script]
}

#[test]
fn agent_transport_full_flow_and_cleanup() {
    let dir = scratch("agent");
    let mut app = App::new(true);
    let mut conn = Connection::new(Transport::Agent(agent_script(&dir, false)));
    assert!(pump_until(&mut conn, &mut app, 8, |a| {
        a.hello.is_some()
            && a.channels[Channel::Public.index()].messages.len() == 3
            && a.channels[Channel::Updates.index()].messages.len() == 1
            && a.signed_in()
    }));
    let ids: Vec<&str> = app.channels[1]
        .messages
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    assert_eq!(ids, ["h1", "h2", "push1"]);
    assert!(app.is_connected());
    assert_eq!(app.hello.as_ref().unwrap().agent, "mock");
    assert_eq!(app.malformed, 3);

    app.handle_key(key(KeyCode::Char('e')));
    type_str(&mut app, "from test é日");
    app.handle_key(key(KeyCode::Enter));
    assert!(pump_until(&mut conn, &mut app, 8, |a| a
        .draft(Channel::Public)
        .text
        .is_empty()));
    assert!(pump_until(&mut conn, &mut app, 2, |a| {
        a.channels[1].messages.iter().any(|m| m.id == "posted1")
    }));
    std::thread::sleep(Duration::from_millis(100));
    conn.pump(&mut app, Instant::now());
    let posted: Vec<_> = app.channels[1]
        .messages
        .iter()
        .filter(|m| m.id == "posted1")
        .collect();
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].body, "from test é日");

    let pid: i32 = std::fs::read_to_string(dir.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(pid_alive(pid));
    drop(conn);
    let start = Instant::now();
    while pid_alive(pid) && start.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !pid_alive(pid),
        "agent child must be killed and reaped on drop"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn agent_exit_shows_disconnected_then_respawns_and_resyncs() {
    let dir = scratch("respawn");
    let mut app = App::new(true);
    app.handle_key(key(KeyCode::Char('e')));
    type_str(&mut app, "unsent draft");
    app.handle_key(key(KeyCode::Esc));
    let mut conn = Connection::new(Transport::Agent(agent_script(&dir, true)));
    assert!(pump_until(&mut conn, &mut app, 8, |a| matches!(
        a.link,
        LinkState::Disconnected { .. }
    ) && a
        .hello
        .is_some()));
    match &app.link {
        LinkState::Disconnected { reason, retry_ms } => {
            assert!(reason.contains("agent exited: boom stderr"), "{reason}");
            assert_eq!(*retry_ms, Some(500));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(app.draft(Channel::Public).text, "unsent draft");
    let first_messages = app.channels[1].messages.len();
    assert!(first_messages >= 2);

    let count_file = dir.join("count");
    let restarted = pump_until(&mut conn, &mut app, 10, |_| {
        std::fs::read_to_string(&count_file)
            .map(|s| s.lines().count() >= 2)
            .unwrap_or(false)
    });
    assert!(restarted, "agent must be respawned");
    assert!(pump_until(&mut conn, &mut app, 8, |a| a.hello.is_some()
        && a.signed_in()));
    assert_eq!(app.draft(Channel::Public).text, "unsent draft");
    assert_eq!(app.channels[1].messages.len(), first_messages);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn agent_spawn_failure_backs_off_without_panicking() {
    let mut app = App::new(true);
    let mut conn = Connection::new(Transport::Agent(vec!["/nonexistent/nexnet-agent".into()]));
    let t0 = Instant::now();
    assert!(conn.pump(&mut app, t0));
    match &app.link {
        LinkState::Disconnected { reason, retry_ms } => {
            assert!(reason.contains("connect failed"));
            assert_eq!(*retry_ms, Some(500));
        }
        other => panic!("{other:?}"),
    }
    assert!(!conn.is_linked());
    conn.pump(&mut app, t0 + Duration::from_millis(100));
    assert!(matches!(app.link, LinkState::Disconnected { .. }));
    conn.pump(&mut app, t0 + Duration::from_millis(600));
    match &app.link {
        LinkState::Disconnected { retry_ms, .. } => assert_eq!(*retry_ms, Some(1000)),
        other => panic!("{other:?}"),
    }
    let mut last = 0;
    let mut now = t0 + Duration::from_millis(600);
    for _ in 0..12 {
        now += Duration::from_secs(11);
        conn.pump(&mut app, now);
        if let LinkState::Disconnected {
            retry_ms: Some(ms), ..
        } = &app.link
        {
            last = *ms;
        }
    }
    assert_eq!(last, 10_000);
}

#[test]
fn unconfigured_connection_never_connects() {
    let mut app = App::new(false);
    let mut conn = Connection::new(Transport::None);
    assert!(!conn.pump(&mut app, Instant::now()));
    assert_eq!(app.link, LinkState::Unconfigured);
    assert!(!conn.is_linked());
}

struct Pty {
    master: File,
    _slave: File,
    path: PathBuf,
}

fn open_pty() -> Pty {
    unsafe {
        let mut m: libc::c_int = 0;
        let mut s: libc::c_int = 0;
        assert_eq!(
            libc::openpty(
                &mut m,
                &mut s,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut()
            ),
            0
        );
        let mut t: libc::termios = std::mem::zeroed();
        assert_eq!(libc::tcgetattr(s, &mut t), 0);
        libc::cfmakeraw(&mut t);
        assert_eq!(libc::tcsetattr(s, libc::TCSANOW, &t), 0);
        let mut buf = [0 as libc::c_char; 256];
        assert_eq!(libc::ttyname_r(s, buf.as_mut_ptr(), buf.len()), 0);
        let path = std::ffi::CStr::from_ptr(buf.as_ptr())
            .to_str()
            .unwrap()
            .to_string();
        Pty {
            master: File::from_raw_fd(m),
            _slave: File::from_raw_fd(s),
            path: PathBuf::from(path),
        }
    }
}

fn say(w: &mut File, line: &str) {
    w.write_all(format!("{SERIAL_PREFIX}{line}\n").as_bytes())
        .unwrap();
}

fn raw(w: &mut File, line: &str) {
    w.write_all(format!("{line}\n").as_bytes()).unwrap();
}

#[test]
fn serial_transport_over_pty_with_prefix_and_noise() {
    let pty = open_pty();
    let path = pty.path.clone();
    let mut master_w = pty.master.try_clone().unwrap();
    let master_r = pty.master.try_clone().unwrap();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_t = Arc::clone(&seen);
    let bogus = format!(
        r#"{{"event":"message","channel":"public","message":{}}}"#,
        message_json("noise", "should never appear", 1)
    );
    std::thread::spawn(move || {
        let mut reader = BufReader::new(master_r);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let l = line.trim_end_matches(['\r', '\n']).to_string();
            seen_t.lock().unwrap().push(l.clone());
            let Some(payload) = l.strip_prefix(SERIAL_PREFIX) else {
                continue;
            };
            let Ok(req) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            let id = req["id"].as_u64().unwrap();
            raw(
                &mut master_w,
                "[    1.234567] kernel: unrelated console noise",
            );
            raw(&mut master_w, &bogus);
            raw(
                &mut master_w,
                &format!("junk {SERIAL_PREFIX}{{\"event\":\"state\"}}"),
            );
            raw(&mut master_w, "");
            let resp = match req["cmd"].as_str().unwrap() {
                "hello" => {
                    json!({"id": id, "ok": true, "result": {"agent": "serial-mock", "protocol": 1, "methods": ["wallet", "passkey"]}})
                }
                "state" => {
                    let s: Value = serde_json::from_str(&state_json(false, true)).unwrap();
                    json!({"id": id, "ok": true, "result": s})
                }
                "history" => {
                    let ch = req["channel"].as_str().unwrap();
                    let m: Value = serde_json::from_str(&message_json(
                        &format!("hist-{ch}"),
                        &format!("history for {ch}"),
                        1_790_000_000_000,
                    ))
                    .unwrap();
                    json!({"id": id, "ok": true, "result": {"channel": ch, "messages": [m]}})
                }
                "subscribe" => json!({"id": id, "ok": true, "result": {}}),
                "post" => {
                    let m: Value = serde_json::from_str(&message_json(
                        "serial-post",
                        req["body"].as_str().unwrap(),
                        1_790_000_005_000,
                    ))
                    .unwrap();
                    json!({"id": id, "ok": true, "result": {"message": m}})
                }
                _ => json!({"id": id, "ok": false, "error": {"code": "invalid", "message": "?"}}),
            };
            say(&mut master_w, &resp.to_string());
            raw(&mut master_w, "login: ");
        }
    });

    let mut app = App::new(true);
    let mut conn = Connection::new(Transport::Serial(path));
    assert!(pump_until(&mut conn, &mut app, 8, |a| {
        a.hello.is_some()
            && a.signed_in()
            && a.channels[0].loaded
            && a.channels[1].loaded
            && !a.channels[0].messages.is_empty()
            && !a.channels[1].messages.is_empty()
    }));
    assert_eq!(app.hello.as_ref().unwrap().agent, "serial-mock");
    assert_eq!(app.channels[1].messages[0].id, "hist-public");
    assert_eq!(app.channels[0].messages[0].id, "hist-updates");
    for ch in &app.channels {
        assert!(ch.messages.iter().all(|m| m.id != "noise"));
    }
    assert_eq!(app.malformed, 0);

    app.handle_key(key(KeyCode::Char('e')));
    type_str(&mut app, "over serial é");
    app.handle_key(key(KeyCode::Enter));
    assert!(pump_until(&mut conn, &mut app, 8, |a| a.channels[1]
        .messages
        .iter()
        .any(|m| m.id == "serial-post")));
    assert_eq!(app.draft(Channel::Public).text, "");
    assert!(app.channels[1]
        .messages
        .iter()
        .any(|m| m.body == "over serial é"));

    let seen = seen.lock().unwrap();
    let nonempty: Vec<&String> = seen.iter().filter(|l| !l.is_empty()).collect();
    assert!(nonempty.len() >= 6, "{nonempty:?}");
    for l in &nonempty {
        assert!(
            l.starts_with(SERIAL_PREFIX),
            "UI sent an unprefixed line: {l:?}"
        );
    }
    let cmds: Vec<String> = nonempty
        .iter()
        .map(|l| {
            let v: Value = serde_json::from_str(&l[SERIAL_PREFIX.len()..]).unwrap();
            v["cmd"].as_str().unwrap().to_string()
        })
        .collect();
    assert_eq!(
        &cmds[..5],
        ["hello", "state", "history", "history", "subscribe"]
    );
    assert_eq!(cmds[5], "post");
}

#[test]
fn serial_open_failure_is_reported_and_retried() {
    let mut app = App::new(true);
    let mut conn = Connection::new(Transport::Serial(PathBuf::from("/nonexistent/ttyS9")));
    conn.pump(&mut app, Instant::now());
    match &app.link {
        LinkState::Disconnected { reason, retry_ms } => {
            assert!(reason.contains("connect failed"));
            assert!(retry_ms.is_some());
        }
        other => panic!("{other:?}"),
    }
}
