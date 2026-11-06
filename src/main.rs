#![feature(default_field_values, trim_prefix_suffix)]
use std::{
	collections::BTreeMap,
	ffi::OsStr,
	hash::{BuildHasher, RandomState},
	path::PathBuf,
};

use clap::{Args, Parser, Subcommand, ValueEnum};
use color_eyre::eyre::{Result, WrapErr, bail, eyre};
use futures::StreamExt as _;
use rquickjs::CatchResultExt as _;
use tiny_http::{Header, Method, Response, Server};

/// Bundle a markdown call script into one self-contained html file
#[derive(Parser)]
#[command(author, version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("GIT_HASH"), ")"), about, long_about = None)]
struct Cli {
	#[command(subcommand)]
	command: Command,
	#[command(flatten)]
	page: Page,
	/// `build` and `watch` start a missing md as an empty script
	#[arg(long, global = true)]
	new: bool,
}

#[derive(Subcommand)]
enum Command {
	/// write the html file
	Build {
		#[command(flatten)]
		script: Script,
		/// defaults to `<tmp>/scripters/<md stem>.csr.html`
		#[arg(short)]
		o: Option<PathBuf>,
		/// open the result with `xdg-open`
		#[arg(long)]
		open: bool,
	},
	/// serve the html on localhost and open it; the page follows every save of the md, and its Ctrl+S writes the md
	Watch {
		#[command(flatten)]
		script: Script,
	},
	/// fill the `--to` language from the `--from` one, one bit of prose per LLM call, in place; changes to existing `--to` blocks go through `cargo insta review`
	#[command(args_conflicts_with_subcommands = true, arg_required_else_help = true)]
	Translate {
		#[command(subcommand)]
		command: Option<TranslateCommand>,
		#[command(flatten)]
		fill: Option<Fill>,
	},
}

#[derive(Subcommand)]
enum TranslateCommand {
	/// cache espeak-ng's IPA of each line of the `--langs` blocks changed since their last transcription at the bottom of the md, in place; the page shows it on hovering the line
	Transcribe {
		#[command(flatten)]
		script: Script,
		/// comma-separated language codes, each an espeak-ng voice
		#[arg(long, value_delimiter = ',', required = true)]
		langs: Vec<String>,
	},
	/// fill each of `--langs` from `--from-lang` as the plain command does, with one review across them
	RegenerateAll {
		#[command(flatten)]
		script: Script,
		#[arg(long)]
		from_lang: String,
		/// comma-separated language codes; every language of the md but `--from-lang` if none
		#[arg(long, value_delimiter = ',')]
		langs: Option<Vec<String>>,
		/// ask_llm's model tier
		#[arg(long, default_value = "translate")]
		quality: ask_llm::Model,
	},
}

#[derive(Args)]
struct Fill {
	#[command(flatten)]
	script: Script,
	#[arg(long)]
	from: String,
	#[arg(long)]
	to: String,
	/// ask_llm's model tier
	#[arg(long, default_value = "translate")]
	quality: ask_llm::Model,
}

#[derive(Args)]
struct Page {
	/// which way conversation steps advance
	#[arg(short, long, global = true, value_enum, default_value_t = Direction::Vertical)]
	direction: Direction,
	/// which response of each loop points back up: bfs ranks a card below its earliest caller, dfs below its latest. Outranks the md's `[layout="…"]: #`; dfs if neither is given
	#[arg(short, long, global = true, value_enum)]
	layout: Option<Layout>,
}

#[derive(Args)]
struct Script {
	md: PathBuf,
}

impl Script {
	fn title(&self) -> Result<String> {
		let stem = self.md.file_stem().ok_or_else(|| eyre!("{} has no file name", self.md.display()))?.to_string_lossy();
		Ok(stem.trim_suffix(".scr").to_owned())
	}

	fn create(&self) -> Result<()> {
		match std::fs::File::create_new(&self.md) {
			Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
			r => r.map(drop).wrap_err_with(|| format!("creating {}", self.md.display())),
		}
	}

	fn read(&self) -> Result<String> {
		std::fs::read_to_string(&self.md).wrap_err_with(|| format!("reading {}", self.md.display()))
	}
}

fn main() -> Result<()> {
	color_eyre::install()?;
	let Cli { command, page, new } = Cli::parse();
	match &command {
		Command::Build { script, .. } | Command::Watch { script } if new => script.create()?,
		Command::Translate { .. } if new => bail!("--new applies to `build` and `watch` alone"),
		_ => {}
	}
	match command {
		Command::Build { script, o, open } => {
			let title = script.title()?;
			let out = match o {
				Some(o) => o,
				None => {
					let dir = std::env::temp_dir().join("scripters");
					std::fs::create_dir_all(&dir).wrap_err_with(|| format!("creating {}", dir.display()))?;
					dir.join(format!("{title}.csr.html"))
				}
			};
			std::fs::write(&out, bundle(&title, &page, &script.read()?, None)?).wrap_err_with(|| format!("writing {}", out.display()))?;
			println!("{}", out.display());
			if open {
				xdg_open(out.as_os_str())?;
			}
			Ok(())
		}
		Command::Watch { script } => watch(&script, &page),
		Command::Translate {
			command: Some(TranslateCommand::Transcribe { script, langs }),
			fill: None,
		} => transcribe(&script, &langs),
		Command::Translate {
			command: Some(TranslateCommand::RegenerateAll { script, from_lang, langs, quality }),
			fill: None,
		} => {
			let langs = match langs {
				Some(langs) => langs,
				None => {
					let all: Vec<String> = serde_json::from_value(Format::try_new()?.call("(md => parsed(md).langs)", serde_json::json!([script.read()?]))?)?;
					all.into_iter().filter(|l| *l != from_lang).collect()
				}
			};
			if langs.is_empty() {
				bail!("{} has no language but `{from_lang}` to regenerate; name new ones in --langs", script.md.display());
			}
			translate(&script, &from_lang, &langs, quality)
		}
		Command::Translate {
			command: None,
			fill: Some(Fill { script, from, to, quality }),
		} => translate(&script, &from, &[to], quality),
		Command::Translate { .. } => unreachable!("clap: args conflict with subcommands, and some are required"),
	}
}

fn translate(script: &Script, from: &str, tos: &[String], quality: ask_llm::Model) -> Result<()> {
	let md = script.read()?;
	let format = Format::try_new()?;
	let texts: BTreeMap<String, Vec<String>> = serde_json::from_value(format.call("bits", serde_json::json!([md, from, tos]))?)?;
	let pairs: Vec<(String, String)> = texts.into_iter().flat_map(|(lang, ts)| ts.into_iter().map(move |t| (lang.clone(), t))).collect();
	eprintln!("translating {} texts from `{from}` to `{}`", pairs.len(), tos.join("`, `"));
	let client = ask_llm::Client::new(ask_llm::config::AppConfig::default()).model(quality);
	let ask = async |(to, text): (String, String)| {
		let prompt = format!(
			"Translate this line of a sales call script from the language `{from}` into the language `{to}`. Keep its inline markdown (**bold**, *italics*, `code`, [links](url)) as it is. Answer with the translation alone, on one line.\n\n{text}"
		);
		let answer = match client.ask(prompt).await {
			Ok(r) => match r.text.trim() {
				"" => Err(eyre!("empty answer")),
				t if t.contains('\n') => Err(eyre!("answer spans lines:\n{t}")),
				t => Ok(t.to_owned()),
			},
			Err(e) => Err(eyre!(e)),
		};
		(to, text, answer)
	};
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().wrap_err("starting the async runtime")?;
	let answers: Vec<_> = runtime.block_on(futures::stream::iter(pairs).map(ask).buffer_unordered(8).collect());
	let total = answers.len();
	let mut maps: BTreeMap<String, serde_json::Map<String, serde_json::Value>> = tos.iter().map(|to| (to.clone(), serde_json::Map::new())).collect();
	let mut failed = Vec::new();
	for (to, text, answer) in answers {
		match answer {
			Ok(t) => {
				maps.get_mut(&to).expect("bits returns only `tos`").insert(text, t.into());
			}
			Err(e) => failed.push(format!("`{to}` {text:?}: {e:?}")),
		}
	}
	if !failed.is_empty() {
		bail!("{} of {total} translations failed; nothing written:\n{}", failed.len(), failed.join("\n"));
	}
	let applied = format.call("apply", serde_json::json!([md, from, tos, maps, {}]))?;
	let conflicts = applied["conflicts"].as_array().expect("apply returns {md, conflicts: []}");
	let out = if conflicts.is_empty() {
		applied
	} else {
		let accepted = review(script, conflicts)?;
		format.call("apply", serde_json::json!([md, from, tos, maps, accepted]))?
	};
	let out = out["md"].as_str().expect("apply returns {md, conflicts: []}");
	std::fs::write(&script.md, out).wrap_err_with(|| format!("writing {}", script.md.display()))
}

fn transcribe(script: &Script, langs: &[String]) -> Result<()> {
	let md = script.read()?;
	let format = Format::try_new()?;
	let todo: serde_json::Map<String, serde_json::Value> = serde_json::from_value(format.call("untranscribed", serde_json::json!([md, langs]))?)?;
	let mut ipa = serde_json::Map::new();
	for (lang, prose) in todo {
		let prose = prose.as_array().expect("untranscribed returns {lang → [prose]}");
		eprintln!("transcribing {} `{lang}` lines", prose.len());
		let mut out = serde_json::Map::new();
		for p in prose {
			let p = p.as_str().expect("prose is a string");
			out.insert(p.to_owned(), espeak(&lang, p)?.into());
		}
		ipa.insert(lang, out.into());
	}
	let out = format.call("transcribe", serde_json::json!([md, langs, ipa]))?;
	std::fs::write(&script.md, out.as_str().expect("transcribe returns the md")).wrap_err_with(|| format!("writing {}", script.md.display()))
}

/// espeak-ng puts each clause of `text` on its own line; they are joined into one
fn espeak(voice: &str, text: &str) -> Result<String> {
	use std::{io::Write as _, process::Stdio};
	let mut child = std::process::Command::new("espeak-ng")
		.args(["-q", "--ipa", "-v", voice])
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.wrap_err("running espeak-ng; is it installed?")?;
	child.stdin.take().expect("piped above").write_all(text.as_bytes()).wrap_err("writing to espeak-ng")?;
	let out = child.wait_with_output().wrap_err("waiting for espeak-ng")?;
	if !out.status.success() {
		bail!("`espeak-ng -v {voice}` exited with {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
	}
	let mut raw = String::from_utf8(out.stdout).wrap_err("espeak-ng wrote non-utf8")?;
	// `(en)…(ru)`: where espeak-ng switches to another voice's rules for a foreign word
	while let Some((i, len)) = raw.match_indices('(').find_map(|(i, _)| {
		let close = raw[i..].find(')')?;
		(close > 1 && raw[i + 1..i + close].bytes().all(|b| b.is_ascii_lowercase() || b == b'-')).then_some((i, close + 1))
	}) {
		raw.replace_range(i..i + len, "");
	}
	let ipa = raw.split_whitespace().collect::<Vec<_>>().join(" ");
	if ipa.is_empty() {
		bail!("espeak-ng -v {voice} read nothing of {text:?}");
	}
	Ok(ipa)
}

/// Each conflict becomes a pending snapshot `<lang>.<key>` of a throwaway crate, so `cargo insta review` shows the old block against the new one; the accepted ones are returned as {lang → [key]}.
fn review(script: &Script, conflicts: &[serde_json::Value]) -> Result<BTreeMap<String, Vec<String>>> {
	let dir = tempfile::tempdir().wrap_err("creating a dir for the review")?;
	let root = dir.path();
	let write = |path: PathBuf, content: &str| std::fs::write(&path, content).wrap_err_with(|| format!("writing {}", path.display()));
	write(root.join("Cargo.toml"), "[package]\nname = \"review\"\nversion = \"0.0.0\"\nedition = \"2024\"\n")?; // cargo-insta runs `cargo metadata` on it
	std::fs::create_dir(root.join("src")).wrap_err("creating the review crate")?;
	write(root.join("src/lib.rs"), "")?;
	let field = |c: &serde_json::Value, k: &str| c[k].as_str().expect("conflicts are {lang, key, title, old, new} strings").to_owned();
	let snap = |c: &serde_json::Value| root.join(format!("{}.{}.snap", field(c, "lang"), field(c, "key")));
	for c in conflicts {
		let header = format!(
			"---\nsource: {}\nexpression: {}\n---\n",
			script.md.display(),
			serde_json::json!(format!("{} [{}]", field(c, "title"), field(c, "lang")))
		);
		write(snap(c), &(header.clone() + &field(c, "old")))?;
		write(snap(c).with_extension("snap.new"), &(header + &field(c, "new")))?;
	}
	eprintln!("{} existing blocks would change; accept the ones to overwrite", conflicts.len());
	let status = std::process::Command::new("cargo")
		.args(["insta", "review", "--workspace-root"])
		.arg(root)
		.status()
		.wrap_err("running `cargo insta review`")?;
	if !status.success() {
		bail!("`cargo insta review` exited with {status}; nothing written. It reviews overwrites of existing blocks: `cargo install cargo-insta` if it is missing");
	}
	let mut accepted: BTreeMap<String, Vec<String>> = BTreeMap::new();
	for c in conflicts {
		let path = snap(c);
		let content = std::fs::read_to_string(&path).wrap_err_with(|| format!("reading {}", path.display()))?;
		let body = content.splitn(3, "---\n").nth(2).ok_or_else(|| eyre!("{} lost its header", path.display()))?;
		if body.trim_end() == field(c, "new").trim_end() {
			accepted.entry(field(c, "lang")).or_default().push(field(c, "key"));
		}
	}
	Ok(accepted)
}

/// web/translate.js on web/model.js, as the format is parsed nowhere else
struct Format(rquickjs::Context);

impl Format {
	fn try_new() -> Result<Self> {
		let context = rquickjs::Context::full(&rquickjs::Runtime::new()?)?;
		context.with(|ctx| -> Result<()> {
			for src in [include_str!("../web/model.js"), include_str!("../web/translate.js")] {
				ctx.eval::<(), _>(src).catch(&ctx).map_err(|e| eyre!("{e}"))?;
			}
			Ok(())
		})?;
		Ok(Self(context))
	}

	/// `args`: a json array
	fn call(&self, f: &str, args: serde_json::Value) -> Result<serde_json::Value> {
		self.0.with(|ctx| {
			let json: String = ctx.eval(format!("JSON.stringify({f}(...{args}))")).catch(&ctx).map_err(|e| eyre!("{e}"))?;
			Ok(serde_json::from_str(&json)?)
		})
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
fn watch(script: &Script, page: &Page) -> Result<()> {
	let title = script.title()?;
	let hasher = RandomState::new();
	let version = |src: &str| format!("{:x}", hasher.hash_one(src));
	let build = |src: &str| -> Result<(String, String)> {
		let v = version(src);
		let html = bundle(&title, page, src, Some(&v))?;
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
					format!("{} changed on disk since this page loaded; download a copy with Export to keep these edits", script.md.display()),
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

/// web/layout.js implements each
#[derive(Clone, Copy, ValueEnum)]
enum Layout {
	Bfs,
	Dfs,
}

/// `live`: the md version a `watch` page was built from
// r[impl page.standalone]
fn bundle(title: &str, page: &Page, md: &str, live: Option<&str>) -> Result<String> {
	let lower = md.to_ascii_lowercase();
	if lower.contains("<script") || lower.contains("</script") {
		bail!("markdown contains a <script> tag; it would break out of the embedding <script> block");
	}
	let title = title.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
	let live = live.map(|v| format!(" data-live=\"{v}\"")).unwrap_or_default();
	let layout = match page.layout {
		None => "",
		Some(Layout::Bfs) => " data-layout=\"bfs\"",
		Some(Layout::Dfs) => " data-layout=\"dfs\"",
	};
	let icon = include_str!("../web/icon.svg").replace('"', "'").replace('#', "%23"); // data: url, inside a "-quoted href
	let parts = [
		("@TITLE@", title.as_str()),
		("@ICON@", icon.as_str()),
		("@REPO@", env!("CARGO_PKG_REPOSITORY")),
		("@LIVE@", live.as_str()),
		("@LAYOUT@", layout),
		(
			"@RANKDIR@",
			match page.direction {
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
		("/*@MERGE@*/", include_str!("../web/merge.js")),
		("/*@LAYOUT_JS@*/", include_str!("../web/layout.js")),
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
