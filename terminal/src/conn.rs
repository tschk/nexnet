use std::time::{Duration, Instant};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

use crate::app::{App, LinkState};
use crate::link::{Backoff, Link, LinkMsg, Transport};

const DRAIN_LIMIT: usize = 256;
const STABLE_AFTER: Duration = Duration::from_secs(5);

pub struct Connection {
    transport: Transport,
    link: Option<Link>,
    backoff: Backoff,
    retry_at: Option<Instant>,
    connected_at: Option<Instant>,
    valid_at_connect: u64,
}

impl Connection {
    pub fn new(transport: Transport) -> Connection {
        Connection {
            transport,
            link: None,
            backoff: Backoff::new(),
            retry_at: None,
            connected_at: None,
            valid_at_connect: 0,
        }
    }

    pub fn is_linked(&self) -> bool {
        self.link.is_some()
    }

    pub fn pump(&mut self, app: &mut App, now: Instant) -> bool {
        if !self.transport.is_configured() {
            return false;
        }
        let mut changed = app.expire_requests(now, REQUEST_TIMEOUT);
        if self.link.is_none() {
            let due = self.retry_at.is_none_or(|t| now >= t);
            if due {
                changed = true;
                app.on_link_connecting();
                match self.transport.connect() {
                    Ok(link) => {
                        self.link = Some(link);
                        self.retry_at = None;
                        self.connected_at = Some(now);
                        self.valid_at_connect = app.valid_lines;
                        app.on_link_up();
                    }
                    Err(e) => {
                        let delay = self.backoff.next_delay_ms();
                        self.retry_at = Some(now + Duration::from_millis(delay));
                        app.on_link_down(&format!("connect failed: {e}"), Some(delay));
                    }
                }
            } else if let Some(t) = self.retry_at {
                let remaining = t.saturating_duration_since(now).as_millis() as u64;
                if let LinkState::Disconnected { reason, retry_ms } = &app.link {
                    let shown = retry_ms.map(|m| m.div_ceil(1000));
                    if shown != Some(remaining.div_ceil(1000)) {
                        let reason = reason.clone();
                        app.link = LinkState::Disconnected {
                            reason,
                            retry_ms: Some(remaining),
                        };
                        changed = true;
                    }
                }
            }
        }
        if let Some(link) = &self.link {
            let mut closed: Option<String> = None;
            for _ in 0..DRAIN_LIMIT {
                match link.try_recv() {
                    None => break,
                    Some(LinkMsg::Line(l)) => {
                        changed = true;
                        app.on_line(&l);
                    }
                    Some(LinkMsg::Malformed) => {
                        changed = true;
                        app.on_malformed();
                    }
                    Some(LinkMsg::Closed(reason)) => {
                        closed = Some(reason);
                        break;
                    }
                }
            }
            if closed.is_none() {
                for line in app.take_outbox() {
                    link.send(&line);
                }
            }
            if let Some(reason) = closed {
                changed = true;
                let stable = app.valid_lines > self.valid_at_connect
                    && self
                        .connected_at
                        .is_some_and(|t| now.saturating_duration_since(t) >= STABLE_AFTER);
                if stable {
                    self.backoff.reset();
                }
                self.link = None;
                let delay = self.backoff.next_delay_ms();
                self.retry_at = Some(now + Duration::from_millis(delay));
                app.on_link_down(&reason, Some(delay));
            }
        }
        changed
    }
}
