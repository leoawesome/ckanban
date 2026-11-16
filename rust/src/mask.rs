//! Hiding saved secrets in answers, as Bun does:
//! - `maskSavedJson` (`src/integrations/board-keys.ts`): every JSON answer Bun sends goes through it; each secret the
//!   pass store holds is replaced (in its JSON-escaped form) by `***`.
//! - `maskText` (`src/integrations/passes.ts`) and `maskSecrets` (`src/integrations/mcp.ts`): a pass's error text,
//!   with known secrets and anything that looks like one hidden.
//!
//! JS strings count UTF-16 units: `length` checks here do the same.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::Value;

/// `s.length` in JS.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `savedSecrets`: every secret of the pass store (keys and tokens of every board) at least 8 long, longest first.
pub fn saved_secrets(passes: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in passes {
        for s in [ptr(p, "secret"), ptr(p, "tokens/access"), ptr(p, "tokens/refresh"), ptr(p, "oauth/clientSecret")] {
            if let Some(s) = s.filter(|s| js_len(s) >= 8)
                && !out.iter().any(|x| x == s)
            {
                out.push(s.to_string());
            }
        }
    }
    // Stable, like Array.prototype.sort: equal lengths keep their first-seen order.
    out.sort_by_key(|s| std::cmp::Reverse(js_len(s)));
    out
}

/// `Passes.secrets()`: the same values at least 6 long, duplicates kept, in store order (maskText sorts them).
pub fn pass_secrets(passes: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for p in passes {
        for s in [ptr(p, "secret"), ptr(p, "tokens/access"), ptr(p, "tokens/refresh"), ptr(p, "oauth/clientSecret")] {
            if let Some(s) = s.filter(|s| js_len(s) >= 6) {
                out.push(s.to_string());
            }
        }
    }
    out
}

fn ptr<'a>(p: &'a Value, path: &str) -> Option<&'a str> {
    p.pointer(&format!("/{path}")).and_then(Value::as_str)
}

/// `maskSavedJson`: each secret, as it appears inside a JSON string, becomes `***`.
pub fn mask_saved_json(secrets: &[String], json: &str) -> String {
    let mut out = json.to_string();
    for s in secrets {
        let quoted = serde_json::to_string(s).unwrap_or_default();
        let form = &quoted[1..quoted.len() - 1];
        if out.contains(form) {
            out = out.replace(form, "***");
        }
    }
    out
}

/// JS's `\s` (WhiteSpace and LineTerminator): Rust's Unicode `\s` adds U+0085 and lacks U+FEFF.
const JS_S: &str = r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{S}", JS_S)).expect("valid pattern")
}

static BEARER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)((?-u:bearer|basic|token))[{S}]+(?-u:[A-Za-z0-9._~+/=\-]){12,}"));
static NAMED: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?i)("?(?-u:access_token|refresh_token|api_key|apikey|client_secret|password|secret)"?[{S}]*[:=][{S}]*"?)[^"{S},}]+"#)
});
static SECRET: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u)key|token|secret|pass|auth|sig|cred|bearer"));
static QUERY: LazyLock<Regex> = LazyLock::new(|| re(r"([?&])([^=&{S}]+)=([^&{S}]*)"));
static FLAG: LazyLock<Regex> = LazyLock::new(|| re(r"(^|[{S}])(--?(?-u:[\w\-])+)(=|[{S}]+)([^{S}]+)"));
static PAIR: LazyLock<Regex> = LazyLock::new(|| re(r"(^|[{S}])([A-Za-z_][A-Za-z0-9_]*)=([^{S}]+)"));

/// `maskText(text, secrets)`.
pub fn mask_text(text: &str, secrets: &[String]) -> String {
    let mut sorted: Vec<&String> = secrets.iter().collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(js_len(s)));
    let mut out = text.to_string();
    for s in sorted {
        out = out.replace(s.as_str(), "***");
    }
    let out = BEARER.replace_all(&out, "$1 ***").into_owned();
    let out = NAMED.replace_all(&out, "$1***").into_owned();
    mask_secrets(&out)
}

/// `maskSecrets`: values of secret-looking query params, --flags and KEY=VALUE pairs.
pub fn mask_secrets(s: &str) -> String {
    let s = QUERY.replace_all(s, |c: &Captures| {
        if SECRET.is_match(&c[2]) { format!("{}{}=***", &c[1], &c[2]) } else { c[0].to_string() }
    });
    let s = mask_flags(&s);
    PAIR.replace_all(&s, |c: &Captures| if SECRET.is_match(&c[2]) { format!("{}{}=***", &c[1], &c[2]) } else { c[0].to_string() })
        .into_owned()
}

/// `/(^|\s)(--?[\w-]+)(=|\s+)(?!-)(\S+)/g` without look-ahead: a match whose value starts with `-` is no match at
/// that start (no shorter flag or gap can match there either), so the search goes on one character later.
fn mask_flags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut copied = 0;
    let mut at = 0;
    while at <= s.len() {
        let Some(c) = FLAG.captures_at(s, at) else { break };
        let m = c.get(0).unwrap();
        if c[4].starts_with('-') {
            at = m.start() + s[m.start()..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        out.push_str(&s[copied..m.start()]);
        if SECRET.is_match(&c[2]) {
            out.push_str(&format!("{}{}{}***", &c[1], &c[2], &c[3]));
        } else {
            out.push_str(m.as_str());
        }
        copied = m.end();
        at = if m.end() > m.start() { m.end() } else { m.end() + 1 };
    }
    out.push_str(&s[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saved_secrets_are_unique_long_enough_and_longest_first() {
        let passes = vec![
            json!({ "secret": "short7x" }),
            json!({ "secret": "abcdefgh", "tokens": { "access": "0123456789abc", "refresh": "abcdefgh" } }),
            json!({ "oauth": { "clientSecret": "client-secret-1" } }),
        ];
        assert_eq!(saved_secrets(&passes), vec!["client-secret-1", "0123456789abc", "abcdefgh"]);
        assert_eq!(pass_secrets(&passes), vec!["short7x", "abcdefgh", "0123456789abc", "abcdefgh", "client-secret-1"]);
    }

    #[test]
    fn mask_saved_json_replaces_the_escaped_form() {
        let secrets = vec!["sk\"quote\\x".to_string()];
        let text = serde_json::to_string(&json!({ "a": "has sk\"quote\\x in it" })).unwrap();
        assert_eq!(mask_saved_json(&secrets, &text), r#"{"a":"has *** in it"}"#);
    }

    // Expected values from Bun: maskText(input, ["s3cr3t-value"]).
    #[test]
    fn mask_text_matches_bun() {
        let s = vec!["s3cr3t-value".to_string()];
        let cases = [
            ("failed with s3cr3t-value here", "failed with *** here"),
            ("Authorization: Bearer abcdefghijklmnop rest", "Authorization: Bearer *** rest"),
            ("TOKEN abcdefghijklmnopq", "TOKEN ***"),
            ("token short", "token short"),
            (r#"{"access_token":"xyz123","other":1}"#, r#"{"access_token":"***","other":1}"#),
            ("password = hunter2, ok", "password = ***, ok"),
            ("https://x.io/a?api_key=abc&q=1", "https://x.io/a?api_key=***"),
            ("https://x.io/a?auth=abc&q=1", "https://x.io/a?auth=***&q=1"),
            ("x --pass\u{85}v", "x --pass\u{85}v"),
            ("run --token abc --name x", "run --token *** --name x"),
            ("run --token -x --auth=-y --sig=z", "run --token -x --auth=-y --sig=***"),
            ("MY_SECRET=abc PLAIN=def", "MY_SECRET=*** PLAIN=def"),
            ("", ""),
        ];
        for (input, want) in cases {
            assert_eq!(mask_text(input, &s), want, "{input}");
        }
    }
}
