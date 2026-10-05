use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 65536;
pub const MAX_BODY_BYTES: usize = 2000;
pub const HISTORY_LIMIT: u32 = 50;
pub const SERIAL_PREFIX: &str = "@@nexnet ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Updates,
    Public,
}

impl Channel {
    pub const ALL: [Channel; 2] = [Channel::Updates, Channel::Public];

    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Updates => "updates",
            Channel::Public => "public",
        }
    }

    pub fn index(self) -> usize {
        match self {
            Channel::Updates => 0,
            Channel::Public => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "cmd")]
pub enum Request {
    #[serde(rename = "hello")]
    Hello { protocol: u32 },
    #[serde(rename = "state")]
    State,
    #[serde(rename = "identity.create")]
    IdentityCreate,
    #[serde(rename = "signin")]
    Signin { method: String },
    #[serde(rename = "signout")]
    Signout,
    #[serde(rename = "history")]
    History { channel: Channel, limit: u32 },
    #[serde(rename = "post")]
    Post { channel: Channel, body: String },
    #[serde(rename = "subscribe")]
    Subscribe { channels: Vec<Channel> },
}

#[derive(Serialize)]
struct Envelope<'a> {
    id: u64,
    #[serde(flatten)]
    request: &'a Request,
}

impl Request {
    pub fn to_line(&self, id: u64) -> String {
        serde_json::to_string(&Envelope { id, request: self })
            .unwrap_or_else(|_| String::from("{}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCode {
    Unconfigured,
    Offline,
    Unauthenticated,
    Forbidden,
    Revoked,
    RateLimited,
    Invalid,
    Internal,
    Other(String),
}

impl ErrorCode {
    pub fn parse(s: &str) -> ErrorCode {
        match s {
            "unconfigured" => ErrorCode::Unconfigured,
            "offline" => ErrorCode::Offline,
            "unauthenticated" => ErrorCode::Unauthenticated,
            "forbidden" => ErrorCode::Forbidden,
            "revoked" => ErrorCode::Revoked,
            "rate_limited" => ErrorCode::RateLimited,
            "invalid" => ErrorCode::Invalid,
            "internal" => ErrorCode::Internal,
            other => ErrorCode::Other(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            ErrorCode::Unconfigured => "unconfigured",
            ErrorCode::Offline => "offline",
            ErrorCode::Unauthenticated => "unauthenticated",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::Revoked => "revoked",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::Invalid => "invalid",
            ErrorCode::Internal => "internal",
            ErrorCode::Other(s) => s,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Author {
    pub id: String,
    pub short: String,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Message {
    pub id: String,
    pub author: Author,
    pub body: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct Gateway {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Session {
    pub method: String,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct State {
    #[serde(default)]
    pub gateway: Gateway,
    #[serde(default)]
    pub identity: Option<Author>,
    #[serde(default)]
    pub session: Option<Session>,
    #[serde(default)]
    pub owner: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hello {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub protocol: u32,
    #[serde(default)]
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct History {
    pub channel: Channel,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Posted {
    pub message: Message,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Message { channel: Channel, message: Message },
    State(State),
    Error { code: ErrorCode, message: String },
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: u64,
        outcome: Result<Value, RpcError>,
    },
    Event(Event),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn field<T: for<'de> Deserialize<'de>>(v: &Value, key: &str) -> Result<T, ParseError> {
    let inner = v
        .get(key)
        .ok_or_else(|| ParseError(format!("missing {key}")))?;
    serde_json::from_value(inner.clone()).map_err(|e| ParseError(format!("bad {key}: {e}")))
}

pub fn parse_incoming(line: &str) -> Result<Incoming, ParseError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(ParseError("line too long".into()));
    }
    let v: Value = serde_json::from_str(line).map_err(|e| ParseError(e.to_string()))?;
    let obj = v
        .as_object()
        .ok_or_else(|| ParseError("not an object".into()))?;
    if let Some(ev) = obj.get("event") {
        let name = ev
            .as_str()
            .ok_or_else(|| ParseError("event is not a string".into()))?;
        return match name {
            "message" => Ok(Incoming::Event(Event::Message {
                channel: field(&v, "channel")?,
                message: field(&v, "message")?,
            })),
            "state" => Ok(Incoming::Event(Event::State(field(&v, "state")?))),
            "error" => Ok(Incoming::Event(Event::Error {
                code: ErrorCode::parse(&field::<String>(&v, "code")?),
                message: v
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })),
            _ => Ok(Incoming::Event(Event::Unknown)),
        };
    }
    let id = obj
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| ParseError("missing id".into()))?;
    let ok = obj
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| ParseError("missing ok".into()))?;
    if ok {
        let result = obj.get("result").cloned().unwrap_or(Value::Null);
        Ok(Incoming::Response {
            id,
            outcome: Ok(result),
        })
    } else {
        let err = obj
            .get("error")
            .and_then(Value::as_object)
            .ok_or_else(|| ParseError("missing error".into()))?;
        let code = err
            .get("code")
            .and_then(Value::as_str)
            .ok_or_else(|| ParseError("missing error code".into()))?;
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok(Incoming::Response {
            id,
            outcome: Err(RpcError {
                code: ErrorCode::parse(code),
                message,
            }),
        })
    }
}

pub fn decode<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, ParseError> {
    serde_json::from_value(v.clone()).map_err(|e| ParseError(e.to_string()))
}
