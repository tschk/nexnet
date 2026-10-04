use std::collections::{HashMap, HashSet};

use crepuscularity_tui::ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};

use crate::protocol::{
    self, Channel, ErrorCode, Event, Hello, History, Incoming, Message, Posted, Request, RpcError,
    State, HISTORY_LIMIT, MAX_BODY_BYTES, PROTOCOL_VERSION,
};
use crate::text;
use crate::view;

pub const MAX_MESSAGES_PER_CHANNEL: usize = 1000;
pub const STATUS_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Updates,
    Public,
    Identity,
}

impl Page {
    pub fn next(self) -> Page {
        match self {
            Page::Updates => Page::Public,
            Page::Public => Page::Identity,
            Page::Identity => Page::Updates,
        }
    }

    pub fn prev(self) -> Page {
        match self {
            Page::Updates => Page::Identity,
            Page::Public => Page::Updates,
            Page::Identity => Page::Public,
        }
    }

    pub fn channel(self) -> Option<Channel> {
        match self {
            Page::Updates => Some(Channel::Updates),
            Page::Public => Some(Channel::Public),
            Page::Identity => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    Unconfigured,
    Connecting,
    Connected,
    Disconnected {
        reason: String,
        retry_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Info,
    Ok,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub text: String,
    pub kind: StatusKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Draft {
    pub text: String,
    pub cursor: usize,
}

impl Draft {
    pub fn insert(&mut self, c: char) -> bool {
        if self.text.len() + c.len_utf8() > MAX_BODY_BYTES {
            return false;
        }
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        true
    }

    pub fn backspace(&mut self) {
        if let Some(c) = self.text[..self.cursor].chars().next_back() {
            self.cursor -= c.len_utf8();
            self.text.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            self.text.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        if let Some(c) = self.text[..self.cursor].chars().next_back() {
            self.cursor -= c.len_utf8();
        }
    }

    pub fn right(&mut self) {
        if let Some(c) = self.text[self.cursor..].chars().next() {
            self.cursor += c.len_utf8();
        }
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.text.len();
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChannelView {
    pub messages: Vec<Message>,
    seen: HashSet<String>,
    pub scroll: usize,
    pub loaded: bool,
}

impl ChannelView {
    pub fn insert(&mut self, msg: Message) -> bool {
        if !self.seen.insert(msg.id.clone()) {
            return false;
        }
        let pos = self.messages.partition_point(|m| m.at <= msg.at);
        self.messages.insert(pos, msg);
        if self.messages.len() > MAX_MESSAGES_PER_CHANNEL {
            let removed = self.messages.remove(0);
            self.seen.remove(&removed.id);
        }
        true
    }
}

#[derive(Debug, Clone)]
enum Pending {
    Hello,
    State,
    Create,
    Signin(String),
    Signout,
    History(Channel),
    Post { channel: Channel, body: String },
    Subscribe,
}

pub struct App {
    pub page: Page,
    pub link: LinkState,
    pub hello: Option<Hello>,
    pub state: Option<State>,
    pub channels: [ChannelView; 2],
    pub drafts: [Draft; 2],
    pub editing: bool,
    pub status: Status,
    pub malformed: u32,
    pub valid_lines: u64,
    pub quit: bool,
    pub pane_w: usize,
    pub pane_h: usize,
    method: Option<String>,
    pending: HashMap<u64, Pending>,
    sent_at: HashMap<u64, std::time::Instant>,
    next_id: u64,
    outbox: Vec<String>,
}

impl App {
    pub fn new(configured: bool) -> App {
        let (link, status) = if configured {
            (
                LinkState::Connecting,
                Status {
                    text: String::from("connecting to agent"),
                    kind: StatusKind::Info,
                },
            )
        } else {
            (
                LinkState::Unconfigured,
                Status {
                    text: String::from("no agent configured: reading and posting are disabled"),
                    kind: StatusKind::Error,
                },
            )
        };
        App {
            page: Page::Public,
            link,
            hello: None,
            state: None,
            channels: [ChannelView::default(), ChannelView::default()],
            drafts: [Draft::default(), Draft::default()],
            editing: false,
            status,
            malformed: 0,
            valid_lines: 0,
            quit: false,
            pane_w: 80,
            pane_h: 10,
            method: None,
            pending: HashMap::new(),
            sent_at: HashMap::new(),
            next_id: 1,
            outbox: Vec::new(),
        }
    }

    pub fn take_outbox(&mut self) -> Vec<String> {
        std::mem::take(&mut self.outbox)
    }

    pub fn is_connected(&self) -> bool {
        self.link == LinkState::Connected
    }

    pub fn is_configured(&self) -> bool {
        self.link != LinkState::Unconfigured
    }

    pub fn owner(&self) -> bool {
        self.state.as_ref().is_some_and(|s| s.owner)
    }

    pub fn signed_in(&self) -> bool {
        self.state.as_ref().is_some_and(|s| s.session.is_some())
    }

    pub fn can_edit(&self, page: Page) -> bool {
        match page {
            Page::Public => true,
            Page::Updates => self.owner(),
            Page::Identity => false,
        }
    }

    pub fn methods(&self) -> &[String] {
        self.hello.as_ref().map_or(&[], |h| h.methods.as_slice())
    }

    pub fn selected_method(&self) -> Option<String> {
        let methods = self.methods();
        if let Some(m) = &self.method {
            if methods.contains(m) {
                return Some(m.clone());
            }
        }
        if methods.iter().any(|m| m == "wallet") {
            return Some(String::from("wallet"));
        }
        methods.first().cloned()
    }

    pub fn draft(&self, channel: Channel) -> &Draft {
        &self.drafts[channel.index()]
    }

    pub fn active_draft(&self) -> Option<&Draft> {
        self.page.channel().map(|c| self.draft(c))
    }

    pub fn post_in_flight(&self) -> bool {
        self.pending
            .values()
            .any(|p| matches!(p, Pending::Post { .. }))
    }

    pub fn set_status(&mut self, text: impl AsRef<str>, kind: StatusKind) {
        self.status = Status {
            text: text::sanitize_line(text.as_ref(), STATUS_MAX_CHARS),
            kind,
        };
    }

    fn send(&mut self, req: Request, pending: Pending) {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, pending);
        self.sent_at.insert(id, std::time::Instant::now());
        self.outbox.push(req.to_line(id));
    }

    pub fn expire_requests(
        &mut self,
        now: std::time::Instant,
        timeout: std::time::Duration,
    ) -> bool {
        let late: Vec<u64> = self
            .sent_at
            .iter()
            .filter(|(_, at)| now.saturating_duration_since(**at) >= timeout)
            .map(|(id, _)| *id)
            .collect();
        for id in &late {
            self.sent_at.remove(id);
            if let Some(pending) = self.pending.remove(id) {
                let timed_out = RpcError {
                    code: ErrorCode::Offline,
                    message: "the agent did not answer in time".to_string(),
                };
                self.on_rpc_error(&pending, &timed_out);
            }
        }
        !late.is_empty()
    }

    pub fn on_link_up(&mut self) {
        self.link = LinkState::Connected;
        self.pending.clear();
        self.sent_at.clear();
        self.outbox.clear();
        self.hello = None;
        self.send(
            Request::Hello {
                protocol: PROTOCOL_VERSION,
            },
            Pending::Hello,
        );
        self.send(Request::State, Pending::State);
        for channel in Channel::ALL {
            self.send(
                Request::History {
                    channel,
                    limit: HISTORY_LIMIT,
                },
                Pending::History(channel),
            );
        }
        self.send(
            Request::Subscribe {
                channels: Channel::ALL.to_vec(),
            },
            Pending::Subscribe,
        );
        self.set_status("connected", StatusKind::Ok);
    }

    pub fn on_link_connecting(&mut self) {
        self.link = LinkState::Connecting;
    }

    pub fn on_link_down(&mut self, reason: &str, retry_ms: Option<u64>) {
        self.pending.clear();
        self.sent_at.clear();
        self.outbox.clear();
        let reason = text::sanitize_line(reason, 120);
        self.set_status(format!("disconnected: {reason}"), StatusKind::Error);
        self.link = LinkState::Disconnected { reason, retry_ms };
    }

    pub fn on_malformed(&mut self) {
        self.malformed = self.malformed.saturating_add(1);
    }

    pub fn on_line(&mut self, line: &str) {
        match protocol::parse_incoming(line) {
            Err(_) => self.on_malformed(),
            Ok(Incoming::Event(ev)) => {
                self.valid_lines += 1;
                self.on_event(ev);
            }
            Ok(Incoming::Response { id, outcome }) => {
                self.valid_lines += 1;
                self.sent_at.remove(&id);
                if let Some(p) = self.pending.remove(&id) {
                    match outcome {
                        Ok(v) => self.on_ok(p, &v),
                        Err(e) => self.on_rpc_error(&p, &e),
                    }
                }
            }
        }
    }

    fn on_event(&mut self, ev: Event) {
        match ev {
            Event::Message { channel, message } => self.add_message(channel, message),
            Event::State(s) => self.set_state(s),
            Event::Error { code, message } => {
                let human = human_error(&code, &message, false);
                self.set_status(human, StatusKind::Error);
            }
            Event::Unknown => {}
        }
    }

    fn add_message(&mut self, channel: Channel, message: Message) {
        let width = self.pane_w.saturating_sub(2);
        let added = view::message_height(&message, width);
        let view = &mut self.channels[channel.index()];
        if view.insert(message) && view.scroll > 0 {
            view.scroll = view.scroll.saturating_add(added);
        }
    }

    fn set_state(&mut self, state: State) {
        self.state = Some(state);
        if self.editing && !self.can_edit(self.page) {
            self.editing = false;
        }
    }

    fn on_ok(&mut self, pending: Pending, v: &serde_json::Value) {
        match pending {
            Pending::Hello => match protocol::decode::<Hello>(v) {
                Ok(h) => {
                    if h.protocol != PROTOCOL_VERSION {
                        self.set_status(
                            format!(
                                "agent speaks protocol {} (expected {PROTOCOL_VERSION})",
                                h.protocol
                            ),
                            StatusKind::Error,
                        );
                    }
                    self.hello = Some(h);
                }
                Err(_) => self.on_malformed(),
            },
            Pending::State => match protocol::decode::<State>(v) {
                Ok(s) => self.set_state(s),
                Err(_) => self.on_malformed(),
            },
            Pending::Create => match protocol::decode::<State>(v) {
                Ok(s) => {
                    self.set_state(s);
                    self.set_status("identity created", StatusKind::Ok);
                }
                Err(_) => self.on_malformed(),
            },
            Pending::Signin(method) => match protocol::decode::<State>(v) {
                Ok(s) => {
                    self.set_state(s);
                    self.set_status(format!("signed in with {method}"), StatusKind::Ok);
                }
                Err(_) => self.on_malformed(),
            },
            Pending::Signout => match protocol::decode::<State>(v) {
                Ok(s) => {
                    self.set_state(s);
                    self.set_status("signed out", StatusKind::Ok);
                }
                Err(_) => self.on_malformed(),
            },
            Pending::History(channel) => match protocol::decode::<History>(v) {
                Ok(h) => {
                    let ch = if h.channel == channel {
                        channel
                    } else {
                        h.channel
                    };
                    for m in h.messages {
                        self.channels[ch.index()].insert(m);
                    }
                    self.channels[ch.index()].loaded = true;
                }
                Err(_) => self.on_malformed(),
            },
            Pending::Post { channel, body } => match protocol::decode::<Posted>(v) {
                Ok(p) => {
                    let view = &mut self.channels[channel.index()];
                    view.insert(p.message);
                    view.scroll = 0;
                    let draft = &mut self.drafts[channel.index()];
                    if draft.text == body {
                        draft.clear();
                    }
                    self.set_status("posted", StatusKind::Ok);
                }
                Err(_) => self.on_malformed(),
            },
            Pending::Subscribe => {}
        }
    }

    fn on_rpc_error(&mut self, pending: &Pending, e: &RpcError) {
        let is_post = matches!(pending, Pending::Post { .. });
        let mut msg = human_error(&e.code, &e.message, is_post);
        match pending {
            Pending::Signin(_) => msg = format!("sign-in failed: {msg}"),
            Pending::Create => msg = format!("identity creation failed: {msg}"),
            Pending::Signout => msg = format!("sign-out failed: {msg}"),
            Pending::History(_) => msg = format!("history unavailable: {msg}"),
            _ => {}
        }
        if let Pending::History(c) = pending {
            self.channels[c.index()].loaded = true;
        }
        self.set_status(msg, StatusKind::Error);
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('C')) {
            self.quit = true;
            return;
        }
        if self.editing {
            self.editor_key(key, ctrl);
        } else {
            self.nav_key(key, ctrl);
        }
    }

    fn nav_key(&mut self, key: KeyEvent, ctrl: bool) {
        if ctrl {
            return;
        }
        match key.code {
            KeyCode::Char('q') | KeyCode::Char('Q') => self.quit = true,
            KeyCode::Char('1') => self.page = Page::Updates,
            KeyCode::Char('2') => self.page = Page::Public,
            KeyCode::Char('3') => self.page = Page::Identity,
            KeyCode::Tab => self.page = self.page.next(),
            KeyCode::BackTab => self.page = self.page.prev(),
            _ => match self.page {
                Page::Identity => self.identity_key(key),
                _ => self.chat_key(key),
            },
        }
    }

    fn chat_key(&mut self, key: KeyEvent) {
        let Some(channel) = self.page.channel() else {
            return;
        };
        let page_step = self.pane_h.saturating_sub(1).max(1);
        let view = &mut self.channels[channel.index()];
        match key.code {
            KeyCode::Up => view.scroll = view.scroll.saturating_add(1),
            KeyCode::Down => view.scroll = view.scroll.saturating_sub(1),
            KeyCode::PageUp => view.scroll = view.scroll.saturating_add(page_step),
            KeyCode::PageDown => view.scroll = view.scroll.saturating_sub(page_step),
            KeyCode::Home => view.scroll = usize::MAX / 2,
            KeyCode::End => view.scroll = 0,
            KeyCode::Char('e') | KeyCode::Char('E') | KeyCode::Enter => self.open_editor(),
            _ => {}
        }
    }

    fn open_editor(&mut self) {
        if !self.is_configured() {
            self.set_status(
                "no agent configured: posting is disabled",
                StatusKind::Error,
            );
            return;
        }
        if !self.can_edit(self.page) {
            self.set_status("updates is read-only (owner only)", StatusKind::Info);
            return;
        }
        if let Some(channel) = self.page.channel() {
            let d = &mut self.drafts[channel.index()];
            d.cursor = d.text.len();
            self.editing = true;
        }
    }

    fn editor_key(&mut self, key: KeyEvent, ctrl: bool) {
        let Some(channel) = self.page.channel() else {
            self.editing = false;
            return;
        };
        match key.code {
            KeyCode::Esc => {
                self.editing = false;
                return;
            }
            KeyCode::Enter => {
                self.submit(channel);
                return;
            }
            _ => {}
        }
        let draft = &mut self.drafts[channel.index()];
        let mut full = false;
        match key.code {
            KeyCode::Char('u') if ctrl => draft.clear(),
            KeyCode::Char('a') if ctrl => draft.home(),
            KeyCode::Char('e') if ctrl => draft.end(),
            KeyCode::Char(c) if !ctrl => full = !draft.insert(c),
            KeyCode::Backspace => draft.backspace(),
            KeyCode::Delete => draft.delete(),
            KeyCode::Left => draft.left(),
            KeyCode::Right => draft.right(),
            KeyCode::Home => draft.home(),
            KeyCode::End => draft.end(),
            _ => {}
        }
        if full {
            self.set_status(
                format!("draft is at the {MAX_BODY_BYTES} byte limit"),
                StatusKind::Error,
            );
        }
    }

    fn submit(&mut self, channel: Channel) {
        let body = self.drafts[channel.index()].text.clone();
        if body.trim().is_empty() {
            self.set_status("nothing to post", StatusKind::Info);
            return;
        }
        if !self.is_configured() {
            self.set_status(
                "no agent configured: posting is disabled (draft kept)",
                StatusKind::Error,
            );
            return;
        }
        if !self.is_connected() {
            self.set_status("disconnected: draft kept", StatusKind::Error);
            return;
        }
        if !self.signed_in() {
            self.set_status(
                "signed out: open Identity (3) and sign in to post (draft kept)",
                StatusKind::Error,
            );
            return;
        }
        if self.post_in_flight() {
            self.set_status("a post is already in flight", StatusKind::Info);
            return;
        }
        self.send(
            Request::Post {
                channel,
                body: body.clone(),
            },
            Pending::Post { channel, body },
        );
        self.set_status("posting", StatusKind::Info);
    }

    fn identity_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('c') | KeyCode::Char('C') => {
                if !self.require_connected() {
                    return;
                }
                if self.state.as_ref().is_some_and(|s| s.identity.is_some()) {
                    self.set_status("an identity already exists", StatusKind::Info);
                } else {
                    self.send(Request::IdentityCreate, Pending::Create);
                    self.set_status("creating identity", StatusKind::Info);
                }
            }
            KeyCode::Char('s') | KeyCode::Char('S') => self.cycle_method(),
            KeyCode::Enter => {
                if !self.require_connected() {
                    return;
                }
                match self.selected_method() {
                    Some(method) => {
                        self.send(
                            Request::Signin {
                                method: method.clone(),
                            },
                            Pending::Signin(method.clone()),
                        );
                        self.set_status(format!("signing in with {method}"), StatusKind::Info);
                    }
                    None => {
                        self.set_status("the agent offers no sign-in methods", StatusKind::Error)
                    }
                }
            }
            KeyCode::Char('o') | KeyCode::Char('O') => {
                if !self.require_connected() {
                    return;
                }
                if self.signed_in() {
                    self.send(Request::Signout, Pending::Signout);
                    self.set_status("signing out", StatusKind::Info);
                } else {
                    self.set_status("not signed in", StatusKind::Info);
                }
            }
            _ => {}
        }
    }

    fn cycle_method(&mut self) {
        let methods = self.methods().to_vec();
        if methods.is_empty() {
            self.set_status("the agent offers no sign-in methods", StatusKind::Error);
            return;
        }
        let current = self.selected_method();
        let idx = current
            .and_then(|c| methods.iter().position(|m| *m == c))
            .map_or(0, |i| (i + 1) % methods.len());
        let method = methods[idx].clone();
        self.set_status(format!("sign-in method: {method}"), StatusKind::Info);
        self.method = Some(method);
    }

    fn require_connected(&mut self) -> bool {
        if !self.is_configured() {
            self.set_status("no agent configured", StatusKind::Error);
            return false;
        }
        if !self.is_connected() {
            self.set_status("disconnected from the agent", StatusKind::Error);
            return false;
        }
        true
    }
}

pub fn human_error(code: &ErrorCode, message: &str, posting: bool) -> String {
    let kept = if posting { " (draft kept)" } else { "" };
    let detail = text::sanitize_line(message, 120);
    match code {
        ErrorCode::RateLimited => format!("rate limited: wait a moment and try again{kept}"),
        ErrorCode::Forbidden => format!("not allowed here{kept}"),
        ErrorCode::Revoked => {
            format!("session revoked: open Identity (3) and sign in again{kept}")
        }
        ErrorCode::Unauthenticated => {
            format!("not signed in: open Identity (3) and sign in{kept}")
        }
        ErrorCode::Offline => format!("gateway offline: try again shortly{kept}"),
        ErrorCode::Unconfigured => format!("the agent has no gateway configured{kept}"),
        ErrorCode::Invalid => format!("rejected as invalid: {detail}{kept}"),
        ErrorCode::Internal => format!("agent error: {detail}{kept}"),
        ErrorCode::Other(c) => format!("{}: {detail}{kept}", text::sanitize_line(c, 40)),
    }
}
