use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::Value;
use topo_render::{render_graph, DEFAULT_MAX_TITLE};

fn usage() -> ! {
    eprintln!(
        "usage: topo-render --graph <graph.json> -o <out.html> [--title TEXT] [--max-title N]"
    );
    std::process::exit(2);
}

fn main() -> ExitCode {
    let mut graph_path: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut title = String::from("m_opslog_topo");
    let mut max_title = DEFAULT_MAX_TITLE;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--graph" => graph_path = Some(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            "-o" | "--output" => output = Some(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            "--title" => title = args.next().unwrap_or_else(|| usage()),
            "--max-title" => {
                max_title = args
                    .next()
                    .unwrap_or_else(|| usage())
                    .parse()
                    .unwrap_or_else(|_| usage())
            }
            "-h" | "--help" => {
                println!("topo-render: graph JSON -> self-contained HTML");
                return ExitCode::SUCCESS;
            }
            _ => usage(),
        }
    }

    let graph_path = graph_path.unwrap_or_else(|| usage());
    let output = output.unwrap_or_else(|| usage());

    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let text = fs::read_to_string(&graph_path)?;
        let graph: Value = serde_json::from_str(&text)?;
        let html = render_graph(&graph, &title, max_title)?;
        fs::write(&output, html.as_bytes())?;
        println!("已生成拓扑图：{}  ({} KB)", output.display(), html.len() / 1024);
        Ok(())
    })();

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("错误：{err}");
            ExitCode::from(2)
        }
    }
}
