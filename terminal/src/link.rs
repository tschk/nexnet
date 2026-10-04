use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::protocol::{MAX_LINE_BYTES, SERIAL_PREFIX};

const STDERR_KEEP: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkMsg {
    Line(String),
    Malformed,
    Closed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    None,
    Agent(Vec<String>),
    Serial(PathBuf),
}

impl Transport {
    pub fn connect(&self) -> io::Result<Link> {
        match self {
            Transport::None => Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "no agent configured",
            )),
            Transport::Agent(argv) => Link::spawn_agent(argv),
            Transport::Serial(path) => Link::open_serial(path),
        }
    }

    pub fn is_configured(&self) -> bool {
        !matches!(self, Transport::None)
    }
}

pub struct Link {
    out: Sender<String>,
    rx: Receiver<LinkMsg>,
    child: Option<Child>,
}

impl Link {
    pub fn spawn_agent(argv: &[String]) -> io::Result<Link> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty agent command"))?;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("agent pipes unavailable"));
        };
        let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
        if let Some(mut err) = stderr {
            let tail = Arc::clone(&tail);
            thread::spawn(move || {
                let mut chunk = [0u8; 1024];
                loop {
                    match err.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut buf) = tail.lock() {
                                buf.extend_from_slice(&chunk[..n]);
                                if buf.len() > STDERR_KEEP {
                                    let cut = buf.len() - STDERR_KEEP;
                                    buf.drain(..cut);
                                }
                            }
                        }
                    }
                }
            });
        }
        Ok(Link::from_streams(
            Box::new(stdout),
            Box::new(stdin),
            false,
            Some(child),
            Some(tail),
        ))
    }

    pub fn open_serial(path: &Path) -> io::Result<Link> {
        let reader = OpenOptions::new().read(true).write(true).open(path)?;
        let writer = reader.try_clone()?;
        Ok(Link::from_streams(
            Box::new(reader),
            Box::new(writer),
            true,
            None,
            None,
        ))
    }

    pub fn from_streams(
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        prefixed: bool,
        child: Option<Child>,
        stderr_tail: Option<Arc<Mutex<Vec<u8>>>>,
    ) -> Link {
        let (msg_tx, rx) = mpsc::channel::<LinkMsg>();
        let (out, out_rx) = mpsc::channel::<String>();

        let reader_tx = msg_tx.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            let mut buf = Vec::new();
            loop {
                match read_capped_line(&mut reader, &mut buf, MAX_LINE_BYTES) {
                    Ok(LineRead::Eof) => {
                        let _ = reader_tx.send(LinkMsg::Closed(close_reason(&stderr_tail)));
                        return;
                    }
                    Err(e) => {
                        let _ = reader_tx.send(LinkMsg::Closed(format!("read failed: {e}")));
                        return;
                    }
                    Ok(LineRead::TooLong) => {
                        if reader_tx.send(LinkMsg::Malformed).is_err() {
                            return;
                        }
                    }
                    Ok(LineRead::Line) => {
                        let Ok(text) = std::str::from_utf8(&buf) else {
                            if reader_tx.send(LinkMsg::Malformed).is_err() {
                                return;
                            }
                            continue;
                        };
                        let text = text.trim_end_matches('\r');
                        let payload = if prefixed {
                            match text.strip_prefix(SERIAL_PREFIX) {
                                Some(p) => p,
                                None => continue,
                            }
                        } else {
                            text
                        };
                        if payload.trim().is_empty() {
                            continue;
                        }
                        if reader_tx.send(LinkMsg::Line(payload.to_string())).is_err() {
                            return;
                        }
                    }
                }
            }
        });

        thread::spawn(move || {
            let mut writer = writer;
            for line in out_rx {
                let mut framed = String::with_capacity(line.len() + SERIAL_PREFIX.len() + 1);
                if prefixed {
                    framed.push_str(SERIAL_PREFIX);
                }
                framed.push_str(&line);
                framed.push('\n');
                if let Err(e) = writer
                    .write_all(framed.as_bytes())
                    .and_then(|()| writer.flush())
                {
                    let _ = msg_tx.send(LinkMsg::Closed(format!("write failed: {e}")));
                    return;
                }
            }
        });

        Link { out, rx, child }
    }

    pub fn send(&self, line: &str) -> bool {
        if line.len() > MAX_LINE_BYTES || line.contains('\n') {
            return false;
        }
        self.out.send(line.to_string()).is_ok()
    }

    pub fn try_recv(&self) -> Option<LinkMsg> {
        self.rx.try_recv().ok()
    }

    pub fn recv_timeout(&self, timeout: std::time::Duration) -> Option<LinkMsg> {
        self.rx.recv_timeout(timeout).ok()
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn close_reason(tail: &Option<Arc<Mutex<Vec<u8>>>>) -> String {
    let Some(tail) = tail else {
        return String::from("link closed");
    };
    let text = tail
        .lock()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let last = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let last: String = last.chars().filter(|c| !c.is_control()).take(120).collect();
    if last.is_empty() {
        String::from("agent exited")
    } else {
        format!("agent exited: {last}")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum LineRead {
    Line,
    TooLong,
    Eof,
}

pub fn read_capped_line<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: usize,
) -> io::Result<LineRead> {
    buf.clear();
    let mut overflow = false;
    let mut saw_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(a) => a,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return if saw_any && !overflow && !buf.is_empty() {
                Ok(LineRead::Line)
            } else if overflow {
                Ok(LineRead::TooLong)
            } else {
                Ok(LineRead::Eof)
            };
        }
        saw_any = true;
        let (chunk, found) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..i], Some(i)),
            None => (available, None),
        };
        if !overflow {
            if buf.len() + chunk.len() > cap {
                overflow = true;
                buf.clear();
            } else {
                buf.extend_from_slice(chunk);
            }
        }
        let consumed = found.map_or(chunk.len(), |i| i + 1);
        reader.consume(consumed);
        if found.is_some() {
            return Ok(if overflow {
                LineRead::TooLong
            } else {
                LineRead::Line
            });
        }
    }
}

#[derive(Debug, Clone)]
pub struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub const CAP_MS: u64 = 10_000;

    pub fn new() -> Self {
        Backoff { attempt: 0 }
    }

    pub fn next_delay_ms(&mut self) -> u64 {
        let delay = 500u64
            .checked_shl(self.attempt)
            .unwrap_or(Self::CAP_MS)
            .min(Self::CAP_MS);
        self.attempt = self.attempt.saturating_add(1).min(16);
        delay
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff::new()
    }
}
