#![feature(default_field_values)]
use std::{
	ffi::OsStr,
	hash::{BuildHasher, RandomState},
	path::PathBuf,
};

use clap::{Args, Parser, Subcommand, ValueEnum};
use color_eyre::eyre::{Result, WrapErr, bail, eyre};
use tiny_http::{Header, Method, Response, Server};

/// Bundle a markdown call script into one self-contained html file
#[derive(Parser)]
#[command(author, version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("GIT_HASH"), ")"), about, long_about = None)]
struct Cli {
	#[command(subcommand)]
	command: Command,
}

#[derive(Subcommand)]
enum Command {
	/// write the html file
	Build {
		#[command(flatten)]
		script: Script,
		/// defaults to `<tmp>/call_scripters/<md stem>.html`
		#[arg(short)]
		o: Option<PathBuf>,
		/// open the result with `xdg-open`
		#[arg(long)]
		open: bool,
	},
	/// serve the html on localhost and open it; the page reloads on every save of the md, and its Ctrl+S writes the md
	Watch {
		#[command(flatten)]
		script: Script,
	},
}

#[derive(Args)]
struct Script {
	md: PathBuf,
	/// which way conversation steps advance
	#[arg(short, long, value_enum, default_value_t = Direction::Vertical)]
	direction: Direction,
}

impl Script {
	fn title(&self) -> Result<String> {
		Ok(self.md.file_stem().ok_or_else(|| eyre!("{} has no file name", self.md.display()))?.to_string_lossy().into_owned())
	}

	fn read(&self) -> Result<String> {
		std::fs::read_to_string(&self.md).wrap_err_with(|| format!("reading {}", self.md.display()))
	}
}

fn main() -> Result<()> {
	color_eyre::install()?;
	match Cli::parse().command {
		Command::Build { script, o, open } => {
			let title = script.title()?;
			let out = match o {
				Some(o) => o,
				None => {
					let dir = std::env::temp_dir().join("call_scripters");
					std::fs::create_dir_all(&dir).wrap_err_with(|| format!("creating {}", dir.display()))?;
					dir.join(format!("{title}.html"))
				}
			};
			std::fs::write(&out, bundle(&title, script.direction, &script.read()?, None)?).wrap_err_with(|| format!("writing {}", out.display()))?;
			if open {
				xdg_open(out.as_os_str())?;
			}
			Ok(())
		}
		Command::Watch { script } => watch(&script),
	}
}

fn xdg_open(target: &OsStr) -> Result<()> {
	let status = std::process::Command::new("xdg-open").arg(target).status().wrap_err("running xdg-open")?;
	if !status.success() {
		bail!("xdg-open {} exited with {status}", target.display());
	}
	Ok(())
}

/// The md is reread on every request, so the page's poll of `/version` is what notices a save.
fn watch(script: &Script) -> Result<()> {
	let title = script.title()?;
	let hasher = RandomState::new();
	let version = |src: &str| format!("{:x}", hasher.hash_one(src));
	let build = |src: &str| -> Result<(String, String)> {
		let v = version(src);
		let html = bundle(&title, script.direction, src, Some(&v))?;
		Ok((v, html))
	};
	let mut served = build(&script.read()?)?;
	let mut rejected = None; // version of the md on disk that failed to bundle, so it is reported once
	let mut errors = Taper { last: None, repeats: 0 };
	let server = Server::http("127.0.0.1:0").map_err(|e| eyre!(e))?;
	let addr = server.server_addr().to_ip().expect("bound to an ip address");
	let host = addr.to_string();
	let url = format!("http://{addr}/");
	xdg_open(OsStr::new(&url))?;
	eprintln!("serving {} at {url}", script.md.display());
	//LOOP: serves until the process is killed
	loop {
		let mut req = server.recv().wrap_err("receiving a request")?;
		let disk = match script.read() {
			Ok(src) => {
				errors.last = None;
				let v = version(&src);
				if v != served.0 && rejected.as_ref() != Some(&v) {
					match build(&src) {
						Ok(b) => {
							served = b;
							rejected = None;
						}
						Err(e) => {
							errors.report(format!("{e:?}"));
							rejected = Some(v.clone());
						}
					}
				}
				Some(v)
			}
			Err(e) => {
				errors.report(format!("{e:?}")); // an editor may be mid-save; the page's next poll retries
				None
			}
		};
		let header = |name: &'static str| req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_owned());
		let if_match = header("If-Match");
		let (status, body, content_type) = if header("Host").as_deref() != Some(&host) {
			(403, "unexpected Host".to_owned(), "text/plain") // a DNS-rebound page would name its own host
		} else {
			match (req.method().clone(), req.url().to_owned().as_str()) {
				(Method::Get, "/") => (200, served.1.clone(), "text/html; charset=utf-8"),
				(Method::Get, "/version") => (200, served.0.clone(), "text/plain"),
				(Method::Put, "/") if disk.is_none() || if_match != disk => (
					409,
					format!("{} changed on disk since this page loaded; download a copy with Save to keep these edits", script.md.display()),
					"text/plain",
				),
				(Method::Put, "/") => {
					let mut src = String::new();
					match req.as_reader().read_to_string(&mut src).wrap_err("reading the request body").and_then(|_| build(&src)) {
						Err(e) => (400, format!("{e}"), "text/plain"),
						Ok(b) => match std::fs::write(&script.md, &src).wrap_err_with(|| format!("writing {}", script.md.display())) {
							Err(e) => (500, format!("{e:?}"), "text/plain"),
							Ok(()) => {
								served = b;
								(200, served.0.clone(), "text/plain")
							}
						},
					}
				}
				_ => (404, "not found".to_owned(), "text/plain"),
			}
		};
		let response = Response::from_string(body)
			.with_status_code(status)
			.with_header(Header::from_bytes("Content-Type", content_type).expect("static header is valid"));
		if let Err(e) = req.respond(response) {
			errors.report(format!("responding: {e}")); // the tab went away mid-response
		}
	}
}

/// The page polls every request through here, so a persisting failure would print on each poll.
struct Taper {
	last: Option<String>,
	repeats: u32,
}

impl Taper {
	fn report(&mut self, msg: String) {
		if self.last.as_ref() == Some(&msg) {
			self.repeats += 1;
		} else {
			self.last = Some(msg);
			self.repeats = 1;
		}
		match self.repeats {
			1 => eprintln!("{}", self.last.as_ref().expect("set above")),
			n if n.is_power_of_two() => eprintln!("^ repeated {n} times"),
			_ => {}
		}
	}
}

#[derive(Clone, Copy, ValueEnum)]
enum Direction {
	Horizontal,
	Vertical,
}

/// `live`: the md version a `watch` page was built from
fn bundle(title: &str, direction: Direction, md: &str, live: Option<&str>) -> Result<String> {
	let lower = md.to_ascii_lowercase();
	if lower.contains("<script") || lower.contains("</script") {
		bail!("markdown contains a <script> tag; it would break out of the embedding <script> block");
	}
	let title = title.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
	let live = live.map(|v| format!(" data-live=\"{v}\"")).unwrap_or_default();
	let icon = include_str!("../web/icon.svg").replace('"', "'").replace('#', "%23"); // data: url, inside a "-quoted href
	let parts = [
		("@TITLE@", title.as_str()),
		("@ICON@", icon.as_str()),
		("@REPO@", env!("CARGO_PKG_REPOSITORY")),
		("@LIVE@", live.as_str()),
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
		("/*@PLACE@*/", include_str!("../web/place.js")),
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
