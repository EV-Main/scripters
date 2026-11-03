#![feature(default_field_values)]
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use color_eyre::eyre::{Result, WrapErr, bail, eyre};

/// Bundle a markdown call script into one self-contained html file
#[derive(Parser)]
#[command(author, version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("GIT_HASH"), ")"), about, long_about = None)]
struct Cli {
	md: PathBuf,
	/// which way conversation steps advance
	#[arg(short, long, value_enum, default_value_t = Direction::Vertical)]
	direction: Direction,
	/// defaults to `<tmp>/call_scripters/<md stem>.html`
	#[arg(short)]
	o: Option<PathBuf>,
	/// open the result with `xdg-open`
	#[arg(long)]
	open: bool,
}

fn main() -> Result<()> {
	color_eyre::install()?;
	let Cli { md, direction, o, open } = Cli::parse();
	let src = std::fs::read_to_string(&md).wrap_err_with(|| format!("reading {}", md.display()))?;
	let title = md.file_stem().ok_or_else(|| eyre!("{} has no file name", md.display()))?.to_string_lossy();
	let out = match o {
		Some(o) => o,
		None => {
			let dir = std::env::temp_dir().join("call_scripters");
			std::fs::create_dir_all(&dir).wrap_err_with(|| format!("creating {}", dir.display()))?;
			dir.join(format!("{title}.html"))
		}
	};
	std::fs::write(&out, bundle(&title, direction, &src)?).wrap_err_with(|| format!("writing {}", out.display()))?;
	if open {
		let status = std::process::Command::new("xdg-open").arg(&out).status().wrap_err("running xdg-open")?;
		if !status.success() {
			bail!("xdg-open {} exited with {status}", out.display());
		}
	}
	Ok(())
}

#[derive(Clone, Copy, ValueEnum)]
enum Direction {
	Horizontal,
	Vertical,
}

fn bundle(title: &str, direction: Direction, md: &str) -> Result<String> {
	let lower = md.to_ascii_lowercase();
	if lower.contains("<script") || lower.contains("</script") {
		bail!("markdown contains a <script> tag; it would break out of the embedding <script> block");
	}
	let title = title.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
	let parts = [
		("@TITLE@", title.as_str()),
		(
			"@RANKDIR@",
			match direction {
				Direction::Horizontal => "LR",
				Direction::Vertical => "TB",
			},
		),
		("/*@STYLE@*/", include_str!("../web/style.css")),
		("@SRC@", md),
		("/*@MARKED@*/", include_str!("../web/vendor/marked.min.js")),
		("/*@DAGRE@*/", include_str!("../web/vendor/dagre.min.js")),
		("/*@MODEL@*/", include_str!("../web/model.js")),
		("/*@VIEW@*/", include_str!("../web/view.js")),
	];
	let template = include_str!("../web/template.html");
	let mut at: Vec<(usize, &str, &str)> = parts
		.iter()
		.map(|&(placeholder, content)| {
			let found: Vec<usize> = template.match_indices(placeholder).map(|(i, _)| i).collect();
			assert_eq!(found.len(), 1, "template must hold `{placeholder}` exactly once");
			(found[0], placeholder, content)
		})
		.collect();
	at.sort_by_key(|&(i, ..)| i);
	let mut html = String::with_capacity(template.len() + parts.iter().map(|(_, c)| c.len()).sum::<usize>());
	let mut cursor = 0;
	for (i, placeholder, content) in at {
		assert!(!content.to_ascii_lowercase().contains("</script"), "`{placeholder}` content would close its <script>");
		html.push_str(&template[cursor..i]);
		html.push_str(content);
		cursor = i + placeholder.len();
	}
	html.push_str(&template[cursor..]);
	Ok(html)
}
