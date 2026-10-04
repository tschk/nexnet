use std::io::IsTerminal;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crepuscularity_tui::ratatui::crossterm::event::{self, Event};
use crepuscularity_tui::ratatui::DefaultTerminal;
use nexnet_term::app::App;
use nexnet_term::cli::{parse_args, Cli, USAGE};
use nexnet_term::conn::Connection;
use nexnet_term::link::Transport;
use nexnet_term::view::{ColorMode, View};

const POLL: Duration = Duration::from_millis(50);

fn run(terminal: &mut DefaultTerminal, transport: Transport) -> std::io::Result<()> {
    let view = View::new(ColorMode::detect());
    let mut app = App::new(transport.is_configured());
    let mut conn = Connection::new(transport);
    let mut dirty = true;
    loop {
        if conn.pump(&mut app, Instant::now()) {
            dirty = true;
        }
        if dirty {
            terminal.draw(|frame| view.draw(frame, &mut app))?;
            dirty = false;
        }
        if app.quit {
            return Ok(());
        }
        if event::poll(POLL)? {
            loop {
                if let Event::Key(key) = event::read()? {
                    app.handle_key(key);
                }
                dirty = true;
                if app.quit || !event::poll(Duration::ZERO)? {
                    break;
                }
            }
        }
    }
}

fn main() -> ExitCode {
    let cli = parse_args(
        std::env::args().skip(1),
        std::env::var("NEXNET_AGENT").ok(),
        std::env::var("NEXNET_SERIAL").ok(),
    );
    let transport = match cli {
        Ok(Cli::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Cli::Version) => {
            println!("nexnet {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Ok(Cli::Run(t)) => t,
        Err(e) => {
            eprintln!("nexnet: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        eprintln!("nexnet: needs an interactive terminal");
        return ExitCode::from(2);
    }
    let mut terminal = crepuscularity_tui::ratatui::init();
    let result = run(&mut terminal, transport);
    crepuscularity_tui::ratatui::restore();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("nexnet: {e}");
            ExitCode::FAILURE
        }
    }
}
