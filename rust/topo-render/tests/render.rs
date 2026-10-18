use serde_json::json;
use topo_render::{escape_json_for_script, render_graph, DEFAULT_MAX_TITLE};

#[test]
fn renders_sample_without_placeholders() {
    let graph = json!({
        "schema_version": "1.0",
        "devices": [
            {"id": "h1", "type": "host", "label": "___TITLE___", "ports": []}
        ],
        "links": [],
        "warnings": []
    });
    let html = render_graph(&graph, "Native", DEFAULT_MAX_TITLE).unwrap();
    assert!(html.contains("<title>Native</title>"));
    assert!(html.contains("window.__GRAPH__"));
    assert!(!html.contains("/*__GRAPH__*/"));
}

#[test]
fn script_json_is_escaped() {
    let graph = json!({"label": "</script><script>alert(1)</script>", "u": "\u{2028}"});
    let data = escape_json_for_script(&graph).unwrap();
    assert!(!data.contains("</script>"));
    assert!(data.contains("\\u003C/script>"));
    assert!(data.contains("\\u2028"));
}
