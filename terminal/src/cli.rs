use std::path::PathBuf;

use crate::link::Transport;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cli {
    Help,
    Version,
    Run(Transport),
}

pub const USAGE: &str = "usage: nexnet [--agent <cmd...> | --serial <path>]

  --agent <cmd...>   spawn the agent and talk to it over stdin/stdout
                     (must be the last option; env NEXNET_AGENT, split on spaces)
  --serial <path>    talk to an agent on a character device, lines prefixed
                     with '@@nexnet ' (env NEXNET_SERIAL)
  -h, --help         show this help
  -V, --version      show the version

With neither option nor environment variable the UI starts with reading
disabled. Env NEXNET_COLORS=16|rgb overrides colour detection.";

pub fn parse_args<I>(
    args: I,
    env_agent: Option<String>,
    env_serial: Option<String>,
) -> Result<Cli, String>
where
    I: IntoIterator<Item = String>,
{
    let mut agent: Option<Vec<String>> = None;
    let mut serial: Option<PathBuf> = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Cli::Help),
            "-V" | "--version" => return Ok(Cli::Version),
            "--agent" => {
                if agent.is_some() {
                    return Err(String::from("--agent given twice"));
                }
                let cmd: Vec<String> = iter.by_ref().collect();
                if cmd.is_empty() {
                    return Err(String::from("--agent needs a command"));
                }
                agent = Some(cmd);
            }
            "--serial" => {
                if serial.is_some() {
                    return Err(String::from("--serial given twice"));
                }
                match iter.next() {
                    Some(p) if !p.is_empty() => serial = Some(PathBuf::from(p)),
                    _ => return Err(String::from("--serial needs a path")),
                }
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    match (agent, serial) {
        (Some(_), Some(_)) => Err(String::from("--agent and --serial are mutually exclusive")),
        (Some(a), None) => Ok(Cli::Run(Transport::Agent(a))),
        (None, Some(s)) => Ok(Cli::Run(Transport::Serial(s))),
        (None, None) => {
            let env_agent = env_agent.filter(|s| !s.trim().is_empty());
            let env_serial = env_serial.filter(|s| !s.trim().is_empty());
            match (env_agent, env_serial) {
                (Some(_), Some(_)) => Err(String::from(
                    "NEXNET_AGENT and NEXNET_SERIAL are both set; unset one",
                )),
                (Some(a), None) => Ok(Cli::Run(Transport::Agent(
                    a.split_whitespace().map(str::to_string).collect(),
                ))),
                (None, Some(s)) => Ok(Cli::Run(Transport::Serial(PathBuf::from(s.trim())))),
                (None, None) => Ok(Cli::Run(Transport::None)),
            }
        }
    }
}
