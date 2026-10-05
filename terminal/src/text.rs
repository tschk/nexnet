use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

fn is_bidi(c: char) -> bool {
    matches!(
        c,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{2028}' | '\u{2029}'
    )
}

pub fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| (!c.is_control() || *c == '\n') && !is_bidi(*c))
        .collect()
}

pub fn sanitize_line(s: &str, max_chars: usize) -> String {
    let mut out: String = s
        .chars()
        .filter(|c| !is_bidi(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max_chars + 1)
        .collect();
    if out.chars().count() > max_chars {
        out = out.chars().take(max_chars.saturating_sub(1)).collect();
        out.push('…');
    }
    out
}

pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

pub fn truncate_width(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w + 1 > max {
            break;
        }
        out.push(c);
        used += w;
    }
    if max > 0 {
        out.push('…');
    }
    out
}

pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let max = max.max(1);
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        let mut line_w = 0;
        for word in raw.split(' ') {
            let word_w = width(word);
            if line.is_empty() {
                place_word(word, word_w, max, &mut line, &mut line_w, &mut lines);
            } else if line_w + 1 + word_w <= max {
                line.push(' ');
                line.push_str(word);
                line_w += 1 + word_w;
            } else {
                lines.push(std::mem::take(&mut line));
                line_w = 0;
                place_word(word, word_w, max, &mut line, &mut line_w, &mut lines);
            }
        }
        lines.push(line);
    }
    lines
}

fn place_word(
    word: &str,
    word_w: usize,
    max: usize,
    line: &mut String,
    line_w: &mut usize,
    lines: &mut Vec<String>,
) {
    if word_w <= max {
        line.push_str(word);
        *line_w = word_w;
        return;
    }
    for c in word.chars() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if *line_w + w > max && !line.is_empty() {
            lines.push(std::mem::take(line));
            *line_w = 0;
        }
        line.push(c);
        *line_w += w;
    }
}

pub fn hhmm(at_ms: i64) -> String {
    let secs = at_ms.div_euclid(1000);
    let day_secs = secs.rem_euclid(86_400);
    format!("{:02}:{:02}", day_secs / 3600, (day_secs % 3600) / 60)
}

pub fn datetime_utc(at_ms: i64) -> String {
    let secs = at_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02} UTC",
        day_secs / 3600,
        (day_secs % 3600) / 60
    )
}

pub fn editor_window(text: &str, cursor: usize, avail: usize) -> (String, String, String) {
    let avail = avail.max(2);
    let cursor = cursor.min(text.len());
    let cursor = (0..=cursor)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    let before = &text[..cursor];
    let mut rest = text[cursor..].chars();
    let cur = rest.next();
    let after: String = rest.collect();
    let max_before = ((avail * 2) / 3).max(1).min(avail - 1);
    let mut before_chars: Vec<char> = before.chars().collect();
    let mut bw: usize = before_chars
        .iter()
        .map(|c| UnicodeWidthChar::width(*c).unwrap_or(0))
        .sum();
    let mut start = 0;
    while bw > max_before && start < before_chars.len() {
        bw -= UnicodeWidthChar::width(before_chars[start]).unwrap_or(0);
        start += 1;
    }
    before_chars.drain(..start);
    let before_s: String = before_chars.into_iter().collect();
    let cur_s = cur.map_or_else(|| String::from(" "), |c| c.to_string());
    let used = bw + width(&cur_s);
    let after_s = truncate_exact(&after, avail.saturating_sub(used));
    (before_s, cur_s, after_s)
}

fn truncate_exact(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > max {
            break;
        }
        out.push(c);
        used += w;
    }
    out
}
