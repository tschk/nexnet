use nexnet_term::cli::{parse_args, Cli};
use nexnet_term::link::Transport;
use std::path::PathBuf;

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn defaults_to_unconfigured() {
    assert_eq!(
        parse_args(args(&[]), None, None).unwrap(),
        Cli::Run(Transport::None)
    );
    assert_eq!(
        parse_args(args(&[]), Some("  ".into()), Some(String::new())).unwrap(),
        Cli::Run(Transport::None)
    );
}

#[test]
fn agent_consumes_the_rest() {
    assert_eq!(
        parse_args(
            args(&["--agent", "bun", "run", "agent.ts", "--flag"]),
            None,
            None
        )
        .unwrap(),
        Cli::Run(Transport::Agent(args(&[
            "bun", "run", "agent.ts", "--flag"
        ])))
    );
}

#[test]
fn serial_takes_a_path() {
    assert_eq!(
        parse_args(args(&["--serial", "/dev/ttyS0"]), None, None).unwrap(),
        Cli::Run(Transport::Serial(PathBuf::from("/dev/ttyS0")))
    );
}

#[test]
fn environment_fallbacks() {
    assert_eq!(
        parse_args(args(&[]), Some("bun run a.ts".into()), None).unwrap(),
        Cli::Run(Transport::Agent(args(&["bun", "run", "a.ts"])))
    );
    assert_eq!(
        parse_args(args(&[]), None, Some("/dev/ttyS0".into())).unwrap(),
        Cli::Run(Transport::Serial(PathBuf::from("/dev/ttyS0")))
    );
    assert!(parse_args(args(&[]), Some("a".into()), Some("b".into())).is_err());
}

#[test]
fn cli_beats_environment() {
    assert_eq!(
        parse_args(args(&["--serial", "/dev/x"]), Some("a".into()), None).unwrap(),
        Cli::Run(Transport::Serial(PathBuf::from("/dev/x")))
    );
}

#[test]
fn rejects_bad_usage() {
    assert!(parse_args(args(&["--agent"]), None, None).is_err());
    assert!(parse_args(args(&["--serial"]), None, None).is_err());
    assert!(parse_args(args(&["--serial", "a", "--serial", "b"]), None, None).is_err());
    assert!(parse_args(args(&["--serial", "a", "--agent", "b"]), None, None).is_err());
    assert!(parse_args(args(&["--bogus"]), None, None).is_err());
    assert_eq!(parse_args(args(&["-h"]), None, None).unwrap(), Cli::Help);
    assert_eq!(
        parse_args(args(&["--version"]), None, None).unwrap(),
        Cli::Version
    );
}
