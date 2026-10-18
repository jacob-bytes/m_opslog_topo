//! Native renderer for m_opslog_topo graph JSON.
//!
//! This crate intentionally owns only the graph JSON -> HTML step. Parsing,
//! normalization, layout and browser behavior stay outside this crate.

use serde_json::Value;
use std::fmt;

const INDEX: &str = include_str!("../../../template/index.html");
const STYLE: &str = include_str!("../../../template/style.css");
const APP: &str = include_str!("../../../template/app.js");
const VIS: &str = include_str!("../../../assets/vis-network.min.js");

pub const DEFAULT_MAX_TITLE: usize = 200;

#[derive(Debug)]
pub enum RenderError {
    Json(serde_json::Error),
    TitleTooLong(usize),
    Placeholder(&'static str, usize, usize),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenderError::Json(err) => write!(f, "graph JSON error: {err}"),
            RenderError::TitleTooLong(max) => write!(f, "title exceeds {max} characters"),
            RenderError::Placeholder(token, expected, actual) => write!(
                f,
                "template placeholder {token} expected {expected}, found {actual}"
            ),
        }
    }
}

impl std::error::Error for RenderError {}

impl From<serde_json::Error> for RenderError {
    fn from(value: serde_json::Error) -> Self {
        RenderError::Json(value)
    }
}

/// Escape a title for HTML text context. Mirrors Python's html.escape(quote=True).
pub fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Serialize graph JSON and make it safe inside a `<script>` block.
///
/// Escaping every `<` (not only `</`) also neutralizes `<!--` and
/// case-insensitive closing-tag variants. Browser JSON.parse/JS object
/// literals decode `\u003C` back to `<`, so graph data is unchanged.
pub fn escape_json_for_script(graph: &Value) -> Result<String, RenderError> {
    Ok(serde_json::to_string(graph)?
        .replace('<', "\\u003C")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029"))
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).count()
}

fn fill_template(template: &str, values: &[(&str, &str)]) -> String {
    let extra: usize = values.iter().map(|(_, value)| value.len()).sum();
    let mut out = String::with_capacity(template.len() + extra);
    let mut rest = template;

    loop {
        let mut next: Option<(usize, &str, &str)> = None;
        for (token, value) in values {
            if let Some(pos) = rest.find(token) {
                if next.map_or(true, |(best, _, _)| pos < best) {
                    next = Some((pos, token, value));
                }
            }
        }

        let Some((pos, token, value)) = next else {
            out.push_str(rest);
            break;
        };

        out.push_str(&rest[..pos]);
        out.push_str(value);
        rest = &rest[pos + token.len()..];
    }

    out
}

fn validate_placeholders(template: &str) -> Result<(), RenderError> {
    for (token, expected) in [
        ("/*__STYLE__*/", 1),
        ("/*__VIS__*/", 1),
        ("/*__APP__*/", 1),
        ("/*__GRAPH__*/", 1),
        ("__TITLE__", 2),
    ] {
        let actual = count_occurrences(template, token);
        if actual != expected {
            return Err(RenderError::Placeholder(token, expected, actual));
        }
    }
    Ok(())
}

pub fn render_graph(graph: &Value, title: &str, max_title: usize) -> Result<String, RenderError> {
    if title.chars().count() > max_title {
        return Err(RenderError::TitleTooLong(max_title));
    }

    validate_placeholders(INDEX)?;
    let data = escape_json_for_script(graph)?;
    let title = escape_html(title);

    Ok(fill_template(
        INDEX,
        &[
            ("/*__STYLE__*/", STYLE),
            ("/*__VIS__*/", VIS),
            ("/*__APP__*/", APP),
            ("/*__GRAPH__*/", &data),
            ("__TITLE__", &title),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "schema_version": "1.0",
            "kind": "topology",
            "devices": [],
            "links": [],
            "warnings": []
        })
    }

    #[test]
    fn escapes_title() {
        let html = render_graph(&sample(), "</title><script>alert(1)</script>", DEFAULT_MAX_TITLE).unwrap();
        assert!(html.contains("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>"));
    }

    #[test]
    fn escapes_closing_script_in_graph() {
        let mut graph = sample();
        graph["devices"] = json!([{"id": "h1", "label": "x</script><script>alert(1)</script>"}]);
        let html = render_graph(&graph, "safe", DEFAULT_MAX_TITLE).unwrap();
        assert_eq!(html.matches("</script>").count(), 3);
        assert!(html.contains("\\u003C/script>"));
    }

    #[test]
    fn does_not_rescan_injected_values() {
        let mut graph = sample();
        graph["devices"] = json!([{"id": "h1", "label": "__TITLE__"}]);
        let html = render_graph(&graph, "Real Title", DEFAULT_MAX_TITLE).unwrap();
        assert!(html.contains("__TITLE__"));
        assert!(html.contains("<title>Real Title</title>"));
    }

    #[test]
    fn rejects_long_title() {
        assert!(matches!(
            render_graph(&sample(), &"x".repeat(10), 5),
            Err(RenderError::TitleTooLong(5))
        ));
    }

    #[test]
    fn no_unreplaced_placeholders() {
        let html = render_graph(&sample(), "safe", DEFAULT_MAX_TITLE).unwrap();
        for token in ["/*__STYLE__*/", "/*__VIS__*/", "/*__APP__*/", "/*__GRAPH__*/", "__TITLE__"] {
            assert!(!html.contains(token), "leftover {token}");
        }
    }
}
