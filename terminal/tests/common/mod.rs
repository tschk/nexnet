#![allow(dead_code)]

use crepuscularity_tui::ratatui::backend::TestBackend;
use crepuscularity_tui::ratatui::Terminal;
use nexnet_term::app::App;
use nexnet_term::view::{ColorMode, View};

pub fn render(app: &mut App, w: u16, h: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    let view = View::new(ColorMode::Rgb);
    terminal.draw(|f| view.draw(f, app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    let mut out = String::new();
    for y in 0..h {
        let mut line = String::new();
        let mut skip = 0;
        for x in 0..w {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            let sym = buf[(x, y)].symbol();
            skip = unicode_width::UnicodeWidthStr::width(sym).saturating_sub(1);
            line.push_str(sym);
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

pub fn hello_line(id: u64) -> String {
    format!(
        r#"{{"id":{id},"ok":true,"result":{{"agent":"mock","protocol":1,"methods":["wallet","ssh"]}}}}"#
    )
}

pub const AUTHOR: &str = r#"{"id":"aa","short":"nx1abcd…wxyz","username":"alice"}"#;

pub fn message_json(id: &str, body: &str, at: i64) -> String {
    format!(
        r#"{{"id":"{id}","author":{AUTHOR},"body":{},"at":{at}}}"#,
        serde_json::to_string(body).unwrap()
    )
}

pub fn state_json(owner: bool, signed_in: bool) -> String {
    let session = if signed_in {
        r#"{"method":"ssh","expiresAt":1790000000000}"#
    } else {
        "null"
    };
    format!(
        r#"{{"gateway":{{"status":"online","url":"https://gw.example"}},"identity":{{"id":"aa","short":"nx1abcd…wxyz","username":null}},"session":{session},"owner":{owner}}}"#
    )
}
