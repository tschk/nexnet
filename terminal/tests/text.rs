use nexnet_term::link::{read_capped_line, Backoff, LineRead};
use nexnet_term::text::*;
use std::io::Cursor;

#[test]
fn wraps_on_words_and_hard_breaks_long_words() {
    assert_eq!(wrap("hello world foo", 11), vec!["hello world", "foo"]);
    assert_eq!(wrap("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
    assert_eq!(wrap("a\n\nb", 10), vec!["a", "", "b"]);
    assert_eq!(wrap("", 5), vec![""]);
    for l in wrap("日本語のテキストを折り返す test", 7) {
        assert!(width(&l) <= 7, "{l:?}");
    }
}

#[test]
fn sanitises_control_characters() {
    assert_eq!(sanitize("a\x1b[31mb\tc\x07"), "a[31mb c");
    assert_eq!(sanitize_line("a\nb\x1bc", 10), "a b c");
    assert_eq!(sanitize_line("abcdef", 4), "abc…");
}

#[test]
fn formats_times() {
    assert_eq!(hhmm(0), "00:00");
    assert_eq!(hhmm(1_790_000_000_000), "14:13");
    assert_eq!(datetime_utc(0), "1970-01-01 00:00 UTC");
    assert_eq!(datetime_utc(1_790_000_000_000), "2026-09-21 14:13 UTC");
    assert_eq!(datetime_utc(951_782_400_000), "2000-02-29 00:00 UTC");
}

#[test]
fn editor_window_keeps_cursor_visible() {
    let (b, c, a) = editor_window("hello", 5, 20);
    assert_eq!((b.as_str(), c.as_str(), a.as_str()), ("hello", " ", ""));
    let long = "x".repeat(100);
    let (b, c, a) = editor_window(&long, 100, 20);
    assert!(width(&b) + width(&c) + width(&a) <= 20);
    assert_eq!(c, " ");
    let (b, c, _) = editor_window("日本語", 3, 10);
    assert_eq!((b.as_str(), c.as_str()), ("日", "本"));
    let (b, c, a) = editor_window("é", 1, 10);
    assert_eq!((b.as_str(), c.as_str(), a.as_str()), ("", "é", ""));
}

#[test]
fn caps_lines_and_resyncs() {
    let mut data = Vec::new();
    data.extend_from_slice(b"short\n");
    data.extend_from_slice(&[b'x'; 100]);
    data.extend_from_slice(b"\nafter\nlast");
    let mut r = Cursor::new(data);
    let mut buf = Vec::new();
    assert_eq!(
        read_capped_line(&mut r, &mut buf, 50).unwrap(),
        LineRead::Line
    );
    assert_eq!(buf, b"short");
    assert_eq!(
        read_capped_line(&mut r, &mut buf, 50).unwrap(),
        LineRead::TooLong
    );
    assert_eq!(
        read_capped_line(&mut r, &mut buf, 50).unwrap(),
        LineRead::Line
    );
    assert_eq!(buf, b"after");
    assert_eq!(
        read_capped_line(&mut r, &mut buf, 50).unwrap(),
        LineRead::Line
    );
    assert_eq!(buf, b"last");
    assert_eq!(
        read_capped_line(&mut r, &mut buf, 50).unwrap(),
        LineRead::Eof
    );
}

#[test]
fn line_exactly_at_cap_is_accepted() {
    let mut data = vec![b'y'; 64];
    data.push(b'\n');
    let mut r = Cursor::new(data);
    let mut buf = Vec::new();
    assert_eq!(
        read_capped_line(&mut r, &mut buf, 64).unwrap(),
        LineRead::Line
    );
    assert_eq!(buf.len(), 64);
}

#[test]
fn backoff_doubles_and_caps_at_ten_seconds() {
    let mut b = Backoff::new();
    let delays: Vec<u64> = (0..8).map(|_| b.next_delay_ms()).collect();
    assert_eq!(
        delays,
        vec![500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]
    );
    b.reset();
    assert_eq!(b.next_delay_ms(), 500);
    for _ in 0..100 {
        assert!(b.next_delay_ms() <= Backoff::CAP_MS);
    }
}
