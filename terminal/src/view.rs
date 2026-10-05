use crepuscularity_tui::ratatui::layout::Rect;
use crepuscularity_tui::ratatui::Frame;
use crepuscularity_tui::{render_template, TemplateContext, TemplateValue};

use crate::app::{App, LinkState, Page, StatusKind};
use crate::protocol::{Channel, Message, MAX_BODY_BYTES};
use crate::text;

pub const TEMPLATE: &str = include_str!("../ui/nexnet.crepus");
pub const CHROME_ROWS: u16 = 4;

const PALETTE: [(&str, &str); 9] = [
    ("#10131c", "ansi-0"),
    ("#d8dbe2", "ansi-7"),
    ("#8890a0", "ansi-8"),
    ("#ff8888", "ansi-9"),
    ("#a8d68a", "ansi-10"),
    ("#f0c674", "ansi-11"),
    ("#7ea6e8", "ansi-12"),
    ("#d8a8e8", "ansi-13"),
    ("#7ec8e8", "ansi-14"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Rgb,
    Ansi16,
}

impl ColorMode {
    pub fn detect() -> ColorMode {
        match std::env::var("NEXNET_COLORS").as_deref() {
            Ok("16") | Ok("ansi") => return ColorMode::Ansi16,
            Ok("rgb") | Ok("truecolor") => return ColorMode::Rgb,
            _ => {}
        }
        match std::env::var("TERM").as_deref() {
            Ok("linux") => ColorMode::Ansi16,
            _ => ColorMode::Rgb,
        }
    }
}

pub fn template_source(mode: ColorMode) -> String {
    match mode {
        ColorMode::Rgb => TEMPLATE.to_string(),
        ColorMode::Ansi16 => PALETTE
            .iter()
            .fold(TEMPLATE.to_string(), |acc, (hex, ansi)| {
                acc.replace(hex, ansi)
            }),
    }
}

pub struct View {
    source: String,
}

impl View {
    pub fn new(mode: ColorMode) -> View {
        View {
            source: template_source(mode),
        }
    }

    pub fn draw(&self, frame: &mut Frame, app: &mut App) {
        let area = frame.area();
        if area.width == 0 || area.height == 0 {
            return;
        }
        let ctx = build_context(app, area);
        let _ = render_template(&self.source, &ctx, frame, area);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Head {
        time: String,
        author: String,
        short: String,
        own: bool,
    },
    Body(String),
    Dim(String),
    Blank,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    Ok,
    Warn,
    Bad,
    Dim,
    Plain,
}

pub fn message_height(msg: &Message, width: usize) -> usize {
    1 + text::wrap(&text::sanitize(&msg.body), width.max(1)).len()
}

pub fn message_rows(msg: &Message, width: usize, own: bool) -> Vec<Row> {
    let author_name = msg
        .author
        .username
        .as_deref()
        .filter(|u| !u.is_empty())
        .map(|u| text::sanitize_line(u, 64));
    let short = text::sanitize_line(&msg.author.short, 40);
    let (author, short) = match author_name {
        Some(name) => (name, short),
        None => (short, String::new()),
    };
    let avail = width.saturating_sub(6).max(1);
    let author = text::truncate_width(&author, avail);
    let short_budget = avail.saturating_sub(text::width(&author) + 1);
    let short = if short_budget >= 4 {
        text::truncate_width(&short, short_budget)
    } else {
        String::new()
    };
    let mut rows = vec![Row::Head {
        time: text::hhmm(msg.at),
        author,
        short,
        own,
    }];
    for line in text::wrap(&text::sanitize(&msg.body), width.max(1)) {
        rows.push(Row::Body(format!("  {line}")));
    }
    rows
}

fn notice_rows(app: &App, channel: Channel, width: usize) -> Vec<Row> {
    let lines: Vec<String> = match &app.link {
        LinkState::Unconfigured => vec![
            String::from("no agent configured"),
            String::from("reading and posting are disabled"),
            String::from("start with: nexnet --agent <cmd...>"),
            String::from("        or: nexnet --serial <path>"),
            String::from("env: NEXNET_AGENT / NEXNET_SERIAL"),
        ],
        LinkState::Connecting => vec![String::from("connecting to agent...")],
        LinkState::Disconnected { reason, .. } => {
            vec![format!("agent link down: {reason}")]
        }
        LinkState::Connected => {
            if app.channels[channel.index()].loaded {
                vec![format!("no messages in {} yet", channel.as_str())]
            } else {
                vec![String::from("loading history...")]
            }
        }
    };
    lines
        .iter()
        .flat_map(|l| text::wrap(l, width.max(1)))
        .map(Row::Dim)
        .collect()
}

fn chat_rows(app: &mut App, channel: Channel, pane_h: usize) -> Vec<Row> {
    let width = app.pane_w;
    let own_id = app
        .state
        .as_ref()
        .and_then(|s| s.identity.as_ref())
        .map(|i| i.id.clone());
    let mut all: Vec<Row> = Vec::new();
    let view = &app.channels[channel.index()];
    for m in &view.messages {
        let own = own_id.as_deref() == Some(m.author.id.as_str());
        all.extend(message_rows(m, width.saturating_sub(2), own));
    }
    if all.is_empty() {
        all = notice_rows(app, channel, width);
    }
    let total = all.len();
    let max_scroll = total.saturating_sub(pane_h);
    let view = &mut app.channels[channel.index()];
    view.scroll = view.scroll.min(max_scroll);
    let end = total - view.scroll;
    let start = end.saturating_sub(pane_h);
    let mut rows: Vec<Row> = all.drain(start..end).collect();
    let pad = pane_h.saturating_sub(rows.len());
    let mut out = vec![Row::Blank; pad];
    out.append(&mut rows);
    out
}

fn row_ctx(row: &Row) -> TemplateContext {
    let mut c = TemplateContext::new();
    let (head, body, dim, blank) = match row {
        Row::Head { .. } => (true, false, false, false),
        Row::Body(_) => (false, true, false, false),
        Row::Dim(_) => (false, false, true, false),
        Row::Blank => (false, false, false, true),
    };
    c.set("r_head", head);
    c.set("r_body", body);
    c.set("r_dim", dim);
    c.set("r_blank", blank);
    c.set("r_own", false);
    c.set("r_time", "");
    c.set("r_author", "");
    c.set("r_short", "");
    c.set("r_text", "");
    match row {
        Row::Head {
            time,
            author,
            short,
            own,
        } => {
            c.set("r_time", time.clone());
            c.set("r_author", author.clone());
            c.set("r_short", short.clone());
            c.set("r_own", *own);
        }
        Row::Body(t) | Row::Dim(t) => {
            c.set("r_text", t.clone());
        }
        Row::Blank => {}
    }
    c
}

fn irow_ctx(label: &str, value: &str, tone: Tone) -> TemplateContext {
    let mut c = TemplateContext::new();
    c.set("i_label", label);
    c.set("i_value", value);
    c.set("i_ok", tone == Tone::Ok);
    c.set("i_warn", tone == Tone::Warn);
    c.set("i_bad", tone == Tone::Bad);
    c.set("i_dim", tone == Tone::Dim);
    c.set("i_plain", tone == Tone::Plain);
    c
}

fn identity_rows(app: &App, width: usize) -> Vec<TemplateContext> {
    let value_w = width.saturating_sub(14).max(4);
    let t = |s: &str| text::truncate_width(&text::sanitize_line(s, 200), value_w);
    let mut rows: Vec<(String, String, Tone)> = Vec::new();

    let gateway = match (&app.link, &app.state) {
        (LinkState::Unconfigured, _) => (String::from("n/a"), Tone::Dim),
        (_, None) => (String::from("unknown"), Tone::Dim),
        (_, Some(s)) => {
            let status = if s.gateway.status.is_empty() {
                "unknown"
            } else {
                s.gateway.status.as_str()
            };
            let tone = match status {
                "online" => Tone::Ok,
                "offline" => Tone::Bad,
                "unconfigured" => Tone::Warn,
                _ => Tone::Dim,
            };
            let mut v = status.to_string();
            if let Some(url) = s.gateway.url.as_deref().filter(|u| !u.is_empty()) {
                v.push(' ');
                v.push_str(url);
            }
            (v, tone)
        }
    };
    rows.push((String::from("gateway"), gateway.0, gateway.1));

    let agent = match (&app.link, &app.hello) {
        (LinkState::Unconfigured, _) => (String::from("none configured"), Tone::Warn),
        (LinkState::Connected, Some(h)) => {
            (format!("{} (protocol {})", h.agent, h.protocol), Tone::Ok)
        }
        (LinkState::Connected, None) => (String::from("handshaking"), Tone::Warn),
        (LinkState::Connecting, _) => (String::from("connecting"), Tone::Warn),
        (LinkState::Disconnected { .. }, _) => (String::from("disconnected"), Tone::Bad),
    };
    rows.push((String::from("agent"), agent.0, agent.1));

    let identity = app.state.as_ref().and_then(|s| s.identity.as_ref());
    match identity {
        Some(i) => {
            let mut v = i.short.clone();
            if app.owner() {
                v.push_str(" [owner]");
            }
            rows.push((String::from("identity"), v, Tone::Plain));
            rows.push((
                String::from("username"),
                i.username
                    .clone()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| String::from("none")),
                if i.username.as_deref().is_some_and(|u| !u.is_empty()) {
                    Tone::Plain
                } else {
                    Tone::Dim
                },
            ));
        }
        None => {
            rows.push((String::from("identity"), String::from("none"), Tone::Dim));
            rows.push((String::from("username"), String::from("none"), Tone::Dim));
        }
    }

    let session = match app.state.as_ref().and_then(|s| s.session.as_ref()) {
        Some(s) => match s.expires_at {
            Some(at) => (
                format!("{}, expires {}", s.method, text::datetime_utc(at)),
                Tone::Ok,
            ),
            None => (format!("{}, no expiry", s.method), Tone::Ok),
        },
        None => (String::from("signed out"), Tone::Warn),
    };
    rows.push((String::from("session"), session.0, session.1));

    let selected = app.selected_method();
    let methods = app.methods();
    let method_line = if methods.is_empty() {
        (String::from("none offered"), Tone::Dim)
    } else {
        let parts: Vec<String> = methods
            .iter()
            .map(|m| {
                if Some(m) == selected.as_ref() {
                    format!("[{m}]")
                } else {
                    m.clone()
                }
            })
            .collect();
        (parts.join("  "), Tone::Plain)
    };
    rows.push((String::from("method"), method_line.0, method_line.1));
    rows.push((String::new(), String::new(), Tone::Plain));

    let connected = app.is_connected();
    let has_identity = identity.is_some();
    let signed_in = app.signed_in();
    let tone = |ok: bool| if ok { Tone::Plain } else { Tone::Dim };
    rows.push((
        String::from("c"),
        String::from("create identity (only when none)"),
        tone(connected && !has_identity),
    ));
    rows.push((
        String::from("s"),
        String::from("select sign-in method"),
        tone(!methods.is_empty()),
    ));
    rows.push((
        String::from("Enter"),
        String::from("sign in with selected method"),
        tone(connected && !methods.is_empty()),
    ));
    rows.push((
        String::from("o"),
        String::from("sign out"),
        tone(connected && signed_in),
    ));

    rows.into_iter()
        .map(|(l, v, tone)| irow_ctx(&l, &t(&v), tone))
        .collect()
}

fn hints(app: &App, width: usize) -> String {
    let s = if app.editing {
        String::from("Enter send  Esc leave editor  Ctrl+U clear")
    } else if app.page == Page::Identity {
        String::from("c create  s method  Enter sign in  o sign out  Tab next  q quit")
    } else {
        let scrolled = app
            .page
            .channel()
            .is_some_and(|c| app.channels[c.index()].scroll > 0);
        let mut h = String::new();
        if app.can_edit(app.page) {
            h.push_str("e write  ");
        }
        h.push_str("Up/Dn PgUp/PgDn scroll  ");
        if scrolled {
            h.push_str("End newest  ");
        }
        h.push_str("Tab next  q quit");
        h
    };
    text::truncate_width(&s, width)
}

fn editor_hint(app: &App, width: usize) -> String {
    let s = match app.page {
        Page::Identity => String::new(),
        _ if !app.is_configured() => String::from("no agent configured"),
        Page::Updates if !app.can_edit(Page::Updates) => String::from("updates is read-only"),
        page => {
            let draft = page.channel().map(|c| app.draft(c));
            match draft {
                Some(d) if !d.text.is_empty() => {
                    let flat = text::sanitize_line(&d.text, 200);
                    format!("draft: {flat}  (e to edit)")
                }
                _ => String::from("press e or Enter to write"),
            }
        }
    };
    text::truncate_width(&s, width)
}

pub fn build_context(app: &mut App, area: Rect) -> TemplateContext {
    let width = area.width as usize;
    let pane_h = area.height.saturating_sub(CHROME_ROWS) as usize;
    app.pane_w = width;
    app.pane_h = pane_h.max(1);

    let mut ctx = TemplateContext::new();
    let compact = width < 56;
    let (t1, t2, t3) = if compact {
        ("1 upd", "2 pub", "3 id")
    } else {
        ("1 updates", "2 public", "3 identity")
    };
    let tab = |active: bool, label: &str| {
        if active {
            format!("[{label}]")
        } else {
            label.to_string()
        }
    };
    ctx.set("page_updates", app.page == Page::Updates);
    ctx.set("page_public", app.page == Page::Public);
    ctx.set("page_identity", app.page == Page::Identity);
    ctx.set("tab_updates", tab(app.page == Page::Updates, t1));
    ctx.set("tab_public", tab(app.page == Page::Public, t2));
    ctx.set("tab_identity", tab(app.page == Page::Identity, t3));
    ctx.set("owner", app.owner());

    let (label, ok, warn, bad) = match &app.link {
        LinkState::Unconfigured => (String::from("no agent"), false, true, false),
        LinkState::Connecting => (String::from("connecting"), false, true, false),
        LinkState::Connected => (String::from("connected"), true, false, false),
        LinkState::Disconnected { retry_ms, .. } => (
            match retry_ms {
                Some(ms) => format!("disconnected (retry {}s)", ms.div_ceil(1000)),
                None => String::from("disconnected"),
            },
            false,
            false,
            true,
        ),
    };
    let label = if compact && label.len() > 12 {
        String::from("disconnected")
    } else {
        label
    };
    ctx.set("link_label", label);
    ctx.set("link_ok", ok);
    ctx.set("link_warn", warn);
    ctx.set("link_bad", bad);

    let rows: Vec<TemplateContext> = match app.page.channel() {
        Some(channel) => chat_rows(app, channel, pane_h)
            .iter()
            .map(row_ctx)
            .collect(),
        None => Vec::new(),
    };
    ctx.set("rows", TemplateValue::List(rows));
    ctx.set("irows", TemplateValue::List(identity_rows(app, width)));

    let editing = app.editing && app.page.channel().is_some();
    ctx.set("editing", editing);
    let draft = app.active_draft().cloned().unwrap_or_default();
    let counter = format!("{}/{}", draft.text.len(), MAX_BODY_BYTES);
    let avail = width.saturating_sub(2 + counter.len() + 1);
    let flat_draft = draft.text.clone();
    let (before, cur, after) = text::editor_window(&flat_draft, draft.cursor, avail);
    ctx.set("ed_has_before", !before.is_empty());
    ctx.set("ed_before", before);
    ctx.set("ed_cur", cur);
    ctx.set("ed_after", after);
    ctx.set("ed_count", counter);
    ctx.set("ed_hint", editor_hint(app, width));
    ctx.set("hints", hints(app, width));

    let skipped = if app.malformed == 0 {
        String::new()
    } else if app.malformed > 999 {
        String::from("skipped 999+")
    } else {
        format!("skipped {}", app.malformed)
    };
    ctx.set("has_skipped", app.malformed > 0);
    ctx.set("skipped", skipped);
    ctx.set("status", app.status.text.clone());
    ctx.set("status_ok", app.status.kind == StatusKind::Ok);
    ctx.set("status_info", app.status.kind == StatusKind::Info);
    ctx.set("status_err", app.status.kind == StatusKind::Error);
    ctx
}
