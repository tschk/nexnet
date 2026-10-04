# nexnet-term

Terminal chat UI for Nexnet, built with [Crepuscularity](https://github.com/tschk/crepuscularity)
(`crepuscularity-tui`, ratatui backend). The binary is `nexnet`.

The UI holds no keys, speaks no network protocol and contains no network code.
It talks to an **agent** with newline-delimited JSON, exactly as specified in
[`../docs/terminal-agent.md`](../docs/terminal-agent.md). No telemetry.

## Build

```sh
cargo build --release
cargo zigbuild --release --target x86_64-unknown-linux-musl
cargo zigbuild --release --target i686-unknown-linux-musl
```

Quality gates:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
cargo deny check licenses bans sources
```

The musl targets need `rustup target add` for each triple and `cargo-zigbuild`
with Zig on `PATH`. The release profile is size-optimised (`opt-level = "z"`,
LTO, `panic = "abort"`, stripped).

## Usage

```
nexnet [--agent <cmd...> | --serial <path>]
```

| Option             | Env             | Transport                                                                                                                                                                                                                                                                               |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <cmd...>` | `NEXNET_AGENT`  | Spawn the agent, use its stdin/stdout. Must be the last option. The env value is split on whitespace (no quoting). The agent's stderr is never shown; the last line of it is appended to the `disconnected` message when the agent exits.                                               |
| `--serial <path>`  | `NEXNET_SERIAL` | Open a character device read+write. Every line sent and received carries the prefix `@@nexnet `; received lines without it (console noise) are ignored. The device is switched to raw mode (no echo, no line editing) when opened, because some console drivers reset termios on close. |

Command-line options win over the environment. Giving both transports is an
error. With neither, the UI starts in a "no agent configured" state with
reading and posting disabled; nothing is invented.

`NEXNET_COLORS=16|rgb` forces the palette. By default `TERM=linux` selects the
16-colour palette (ANSI 0-15 instead of RGB); meaning is never carried by
colour alone (active tab is bracketed, selected method is bracketed, the owner
badge and errors are text).

On link loss the UI shows `disconnected (retry Ns)` and re-spawns / reopens
with exponential backoff (0.5s doubling, capped at 10s), then re-runs
`hello`, `state`, `history` (both channels, limit 50) and `subscribe`.
Drafts and cached messages survive reconnects. Malformed, oversize
(> 65536 bytes) or non-UTF-8 lines are skipped and counted (`skipped N`).

## Keys

| Key                                          | Action                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `1` `2` `3`                                  | Updates, Public chat, Identity                                           |
| `Tab` / `Shift+Tab`                          | Next / previous page                                                     |
| `Up` `Down` `PageUp` `PageDown` `Home` `End` | Scroll the message pane (`End` jumps to newest)                          |
| `e` or `Enter`                               | Open the editor (Public; Updates only when `state.owner` is true)        |
| `Enter` (editing)                            | Post; the draft clears only on success                                   |
| `Esc` (editing)                              | Leave the editor, keep the draft                                         |
| `Ctrl+U` / `Ctrl+A` / `Ctrl+E` (editing)     | Clear draft / home / end                                                 |
| `c` (Identity)                               | Create identity (only when none exists)                                  |
| `s` (Identity)                               | Cycle the sign-in method among those the agent offers (default `wallet`) |
| `Enter` (Identity)                           | Sign in with the selected method                                         |
| `o` (Identity)                               | Sign out                                                                 |
| `q`                                          | Quit (plain text while editing)                                          |
| `Ctrl+C`                                     | Quit from anywhere                                                       |

Posting while signed out does not fail silently: the status line points to
Identity (3) and the draft is kept. The same holds for `rate_limited`,
`forbidden`, `revoked`, `unauthenticated`, `offline` and every other error.
Drafts are capped at 2000 bytes with a visible counter. Times are shown in UTC.
Agent-supplied text has control characters stripped before display.

## Layout

The screen is the Crepuscularity template [`ui/nexnet.crepus`](ui/nexnet.crepus),
embedded with `include_str!`. Rust owns state and input and fills the template
context; the message pane is pre-wrapped and windowed in Rust so scrolling is
exact for wrapped and double-width text.
