use std::{
	io::{Read, Write},
	net::TcpStream,
	path::Path,
	process::{Child, Command},
	time::{Duration, Instant},
};

use v_fixtures::{Fixture, FixtureFile, TempFixture};

fn build(test: &str, flags: &[&str], md: &str) -> Result<String, String> {
	let temp = single_file("script.md", md).write_to_tempdir_with_prefix(&format!("scripters_{test}_"));
	let out = Command::new(env!("CARGO_BIN_EXE_scripters"))
		.args(["build", "--direction", "horizontal"])
		.args(flags)
		.arg(temp.path("script.md"))
		.arg("-o")
		.arg(temp.path("script.html"))
		.output()
		.unwrap();
	match out.status.success() {
		true => Ok(temp.read("script.html")),
		false => Err(String::from_utf8(out.stderr).unwrap()),
	}
}

/// `parse` dedents, which would alter the markdown
fn single_file(path: &str, text: &str) -> Fixture {
	Fixture {
		files: vec![FixtureFile {
			path: format!("/{path}"),
			text: text.to_owned(),
		}],
	}
}

// r[verify page.standalone]
#[test]
fn demo_is_self_contained() {
	let md = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo.scr.md")).unwrap();
	let html = build("demo", &[], &md).unwrap();
	assert!(html.contains(&md), "markdown is embedded verbatim");
	for attr in ["src=", "href="] {
		for quote in ["\"", "'", ""] {
			for scheme in ["http", "//"] {
				let needle = format!("{attr}{quote}{scheme}");
				assert!(!html.contains(&needle), "external reference `{needle}`");
			}
		}
	}
}

#[test]
fn script_tag_in_markdown_is_rejected() {
	for md in ["# A\n</script>\n", "# A\n<SCRIPT>alert(1)</SCRIPT>\n"] {
		let err = build("script_tag", &[], md).unwrap_err();
		assert!(err.contains("<script>"), "{err}");
	}
}

/// (status, body)
fn request(addr: &str, host: &str, method: &str, path: &str, if_match: Option<&str>, body: &str) -> (u16, String) {
	let mut stream = TcpStream::connect(addr).unwrap();
	let if_match = if_match.map(|v| format!("If-Match: {v}\r\n")).unwrap_or_default();
	write!(
		stream,
		"{method} {path} HTTP/1.0\r\nHost: {host}\r\n{if_match}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
		body.len()
	)
	.unwrap();
	let mut response = String::new();
	stream.read_to_string(&mut response).unwrap();
	let (head, body) = response.split_once("\r\n\r\n").unwrap();
	(head.split(' ').nth(1).unwrap().parse().unwrap(), body.to_owned())
}

/// `watch` of the `script.md` in `temp`, as (process, host:port)
fn serve(temp: &TempFixture) -> (Child, String) {
	let dir = temp.root.clone();
	let xdg_open = temp.path("xdg-open");
	temp.write("xdg-open", &format!("#!/bin/sh\necho \"$1\" > {}/url\n", dir.display()));
	std::fs::set_permissions(&xdg_open, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
	let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap());
	let child = Command::new(env!("CARGO_BIN_EXE_scripters"))
		.arg("watch")
		.arg(temp.path("script.md"))
		.env("PATH", path)
		.spawn()
		.unwrap();

	let started = Instant::now();
	//LOOP: bounded by the 10s assert
	let url = loop {
		if let Some(url) = temp.try_read("url")
			&& url.ends_with('\n')
		{
			break url;
		}
		assert!(started.elapsed() < Duration::from_secs(10), "watch never opened a url");
		std::thread::sleep(Duration::from_millis(20));
	};
	(child, url.trim().strip_prefix("http://").unwrap().trim_end_matches('/').to_owned())
}

fn chromium() -> &'static str {
	["chromium", "chromium-browser", "google-chrome"]
		.into_iter()
		.find(|b| Command::new(b).arg("--version").output().is_ok_and(|o| o.status.success()))
		.expect("a chromium on PATH")
}

#[test]
fn watch_serves_the_md_on_disk_and_writes_page_saves_back() {
	let temp = single_file("script.md", "# One\n").write_to_tempdir_with_prefix("scripters_watch_");
	let md = temp.path("script.md");
	let (mut child, addr) = serve(&temp);
	let get = |path| request(&addr, &addr, "GET", path, None, "");
	let put = |if_match: &str, body| request(&addr, &addr, "PUT", "/", Some(if_match), body);

	let (status, page) = get("/");
	assert_eq!(status, 200);
	assert!(page.contains("# One"), "{page}");
	assert!(page.contains("data-live="), "{page}");
	let v1 = get("/version").1;

	std::fs::write(&md, "# Two\n").unwrap();
	let v2 = get("/version").1;
	assert_ne!(v1, v2, "an editor's save changes the version");
	assert!(get("/").1.contains("# Two"));

	assert_eq!(put(&v1, "# Stale\n").0, 409, "a page built from an older md must not overwrite a newer one");
	assert_eq!(std::fs::read_to_string(&md).unwrap(), "# Two\n");

	let (status, v3) = put(&v2, "# Three\n");
	assert_eq!(status, 200);
	assert_eq!(std::fs::read_to_string(&md).unwrap(), "# Three\n");
	assert_eq!(get("/version").1, v3, "the page's own save does not reload it");

	std::fs::write(&md, "# Four\n<script>\n").unwrap();
	assert_eq!(get("/version").1, v3, "an md that fails to bundle keeps the last good page");
	assert_eq!(put(&v3, "# Five\n").0, 409, "the unbundlable md on disk is still newer than the page");

	assert_eq!(request(&addr, "evil.example", "GET", "/", None, "").0, 403);

	child.kill().unwrap();
	child.wait().unwrap();
}

/// The page built from `md` with `flags` runs `drive`, then its Export ▾ .md must download `expected`
#[track_caller]
fn check_save(flags: &[&str], md: &str, drive: &str, expected: &str) {
	let html = build("save", flags, md).unwrap();
	let temp = Fixture::default().write_to_tempdir_with_prefix("scripters_save_page_");
	// the downloaded text lands in a <script> block, which the dumped DOM holds verbatim
	let capture = r#"<script>
const out = Object.assign(document.createElement('script'), { type: 'text/plain', id: 'saved' });
document.body.append(out);
const B = Blob;
window.Blob = function (parts, o) { out.textContent = parts.join(''); return new B(parts, o); };
HTMLAnchorElement.prototype.click = () => {};
const button = text => [...document.querySelectorAll('#bar button')].find(b => b.textContent === text);
@DRIVE@
button('.md').click();
</script>
</body>"#
		.replace("@DRIVE@", drive);
	temp.write("script.html", &html.replacen("</body>", &capture, 1));
	let page = temp.path("script.html");
	let out = Command::new(chromium())
		.args(["--headless", "--disable-gpu", "--no-first-run", "--no-sandbox", "--dump-dom"])
		.arg(format!("--user-data-dir={}", temp.path("profile").display()))
		.arg(format!("file://{}", page.display()))
		.output()
		.unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	let dom = String::from_utf8(out.stdout).unwrap();
	let (_, rest) = dom
		.split_once(r#"<script type="text/plain" id="saved">"#)
		.unwrap_or_else(|| panic!("the page never saved:\n{dom}"));
	assert_eq!(rest.split_once("</script>").unwrap().0, expected);
}

// r[verify page.md-truth]
#[test]
fn md_save_round_trips() {
	let demo = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo.scr.md")).unwrap();
	check_save(&[], &demo, "", &demo);
	let md = r#"[hot]: <oklch(0.62 0.19 25)> "Ready"
[k=v]: #
[lang="ru"]: #
[layout="bfs"]: #

---

# Start {.hot} <!-- the opener -->
Hi <!-- inline comment --> there.
<div lang="ru">
Привет
</div>
<div k="v">

- [Go](#next) <!-- not a response: the comment is part of the item -->
- [Go](#next)
</div>
<div k="w">
- [Go](#next)
</div>

## - Group <!-- noop -->
### Next ###
<!--
multi-line comment
-->
###### Deep
- [Back](#start)
"#;
	check_save(&[], md, "", md);
}

#[test]
fn md_save_ends_the_preamble_with_a_rule() {
	check_save(&[], "[layout=\"dfs\"]: #\n# A\n", "", "[layout=\"dfs\"]: #\n\n---\n\n# A\n");
	check_save(&[], "[layout=\"dfs\"]: #\n---\n# A\n", "", "[layout=\"dfs\"]: #\n---\n# A\n");
}

#[test]
fn md_save_marks_the_selection() {
	let md = "# A\n<div k=\"v\">\n</div>\n<div k=\"w\">\n</div>\n";
	let choose = |v: &str| format!("const s = document.querySelector('#bar select'); s.value = '{v}'; s.dispatchEvent(new Event('change'));");
	let layout = "[layout=\"dfs\"]: #\n";
	check_save(&[], md, "", &format!("{layout}\n---\n\n{md}"));
	check_save(&[], md, &choose("w"), &format!("[k=w]: #\n{layout}\n---\n\n{md}"));
	check_save(&[], &format!("[k=v]: #\n\n---\n\n{md}"), &choose("w"), &format!("[k=w]: #\n{layout}\n---\n\n{md}"));
	check_save(&[], &format!("[k=v]: #\n\n---\n\n{md}"), &choose("all"), &format!("{layout}\n---\n\n{md}"));
	let langs = "# A\n<div lang=\"en\">\nhi\n</div>\n<div lang=\"ru\">\nпривет\n</div>\n";
	check_save(&[], langs, "", &format!("[lang=\"en\"]: #\n{layout}\n---\n\n{langs}"));
	check_save(
		&[],
		&format!("[l]: <oklch(0 0 0)>\n{md}"),
		&choose("v"),
		&format!("[l]: <oklch(0 0 0)>\n[k=v]: #\n{layout}\n---\n\n{md}"),
	);
}

#[test]
fn md_save_marks_the_layout_from_the_flag_or_the_bar() {
	let bfs = "[layout=\"bfs\"]: #\n\n---\n\n# A\n";
	check_save(&["-l", "bfs"], "# A\n", "", bfs);
	check_save(&["--layout", "bfs"], "[layout=\"dfs\"]: #\n\n---\n\n# A\n", "", bfs);
	let pick = "const s = [...document.querySelectorAll('#bar label.dim')].find(l => l.firstChild.textContent.trim() === 'layout').querySelector('select'); s.value = 'bfs'; s.dispatchEvent(new Event('change'));";
	check_save(&[], "# A\n", pick, bfs);
}

#[test]
fn a_locked_page_edits_nothing() {
	let md = "[layout=\"dfs\"]: #\n\n---\n\n# A\n";
	let drive = "window.confirm = () => true;
const press = key => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const card = () => document.querySelector('#canvas .card');
press('L');
card().click();
card().click();
const ta = document.querySelector('#canvas textarea');
if (ta) {
	ta.value = '# B';
	ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
}
press('Backspace');
press('N');";
	check_save(&[], md, drive, md);
}

#[test]
fn following_a_variant_response_chooses_its_variant() {
	let md = "# A\n<div k=\"v\">\n- [x](#b)\n</div>\n<div k=\"w\">\n- [y](#b)\n</div>\n# B\n";
	let follow = "[...document.querySelectorAll('#canvas button.label')].find(b => b.textContent === 'k=wy').click();";
	check_save(&[], md, follow, &format!("[k=w]: #\n[layout=\"dfs\"]: #\n\n---\n\n{md}"));
}

#[test]
fn an_inline_variant_inside_a_language_scope_is_chosen_by_clicking_it() {
	let md = "# A\n<div lang=\"en\">\n<div k=\"v\">Hi,</div><div k=\"w\">Hello,</div> **Sam** here.\n</div>\n";
	let choose = "[...document.querySelectorAll('#canvas section.variant')].find(s => s.textContent.includes('Hello')).click();";
	check_save(&[], md, choose, &format!("[k=w]: #\n[lang=\"en\"]: #\n[layout=\"dfs\"]: #\n\n---\n\n{md}"));
}

#[test]
fn new_card_opens_its_editor() {
	let press = |key: &str| format!("document.body.dispatchEvent(new KeyboardEvent('keydown', {{ key: '{key}', bubbles: true }}));");
	let layout = "[layout=\"dfs\"]: #\n\n---\n\n";
	let write = "const ta = document.querySelector('#canvas textarea'); ta.value = '# B\\nHi'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));";
	check_save(&[], "# A\n", &format!("{}{write}", press("N")), &format!("{layout}# A\n\n# B\nHi\n"));
	check_save(
		&[],
		"# New card\n",
		&format!("{}{}", press("N"), press("Escape")),
		&format!("{layout}# New card\n\n# New card 2\n"),
	);
}

#[test]
fn new_creates_a_missing_md_and_keeps_an_existing_one() {
	let temp = single_file("kept.scr.md", "# Kept\n").write_to_tempdir_with_prefix("scripters_new_");
	let run = |md: &str| {
		let out = Command::new(env!("CARGO_BIN_EXE_scripters"))
			.args(["--new", "build"])
			.arg(temp.path(md))
			.arg("-o")
			.arg(temp.path("out.html"))
			.output()
			.unwrap();
		assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	};
	run("fresh.scr.md");
	assert_eq!(temp.read("fresh.scr.md"), "");
	run("kept.scr.md");
	assert_eq!(temp.read("kept.scr.md"), "# Kept\n");
}

#[test]
fn an_empty_script_offers_its_first_card() {
	let write = "document.querySelector('#canvas button.first').click(); const ta = document.querySelector('#canvas textarea'); ta.value = '# A\\nHi'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));";
	check_save(&[], "", write, "[layout=\"dfs\"]: #\n\n---\n\n# A\nHi\n");
}

/// The page `watch` serves for `md` runs the async `drive`, which `press(key, modifiers)` and `sleep(ms)` help; then the md on disk must be `expected`
#[track_caller]
fn check_watch(md: &str, drive: &str, expected: &str) {
	let temp = single_file("script.md", md).write_to_tempdir_with_prefix("scripters_watch_page_");
	let (mut child, addr) = serve(&temp);
	let (status, html) = request(&addr, &addr, "GET", "/", None, "");
	assert_eq!(status, 200);
	// the page runs from file:// so the drive can be added to it; its requests are sent back to the server
	let head = format!("<head>\n<script>const served = fetch; window.fetch = (url, o) => served(new URL(url, 'http://{addr}/'), o);</script>");
	let drive = format!(
		"<script>
const press = (key, o) => document.body.dispatchEvent(new KeyboardEvent('keydown', {{ key, bubbles: true, ...o }}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {{ {drive} }})();
</script>
</body>"
	);
	temp.write("page.html", &html.replacen("<head>", &head, 1).replacen("</body>", &drive, 1));
	let out = Command::new(chromium())
		.args([
			"--headless",
			"--disable-gpu",
			"--no-first-run",
			"--no-sandbox",
			"--disable-web-security",
			"--virtual-time-budget=10000",
			"--dump-dom",
		])
		.arg(format!("--user-data-dir={}", temp.path("profile").display()))
		.arg(format!("file://{}", temp.path("page.html").display()))
		.output()
		.unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	child.kill().unwrap();
	child.wait().unwrap();
	assert_eq!(temp.read("script.md"), expected);
}

#[test]
fn watch_page_edits_merge_with_the_md_saved_elsewhere() {
	let add_card =
		"press('N'); const ta = document.querySelector('#canvas textarea'); ta.value = '# B\\nHi'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));";
	let save_elsewhere = |md: &str| format!("await fetch('/', {{ method: 'PUT', headers: {{ 'If-Match': live }}, body: '{md}' }}); await sleep(1000);");
	let save = "press('s', { ctrlKey: true }); await sleep(1000);";
	let layout = "[layout=\"dfs\"]: #\n\n---\n\n";
	check_watch(
		"# A\n",
		&format!("{add_card}{}{save}", save_elsewhere("# A\\nedited elsewhere\\n")),
		&format!("{layout}# A\nedited elsewhere\n\n# B\nHi\n"),
	);
	// same line edited on both sides: the page takes the disk's, and undo brings its own back
	check_watch(
		"# A\n",
		&format!("{add_card}{}press('u'); {save}", save_elsewhere("# A\\n\\n# C\\n")),
		&format!("{layout}# A\n\n# B\nHi\n"),
	);
}

#[test]
fn a_line_transcribed_since_its_block_last_changed_shows_its_ipa_on_hover() {
	let md = r#"# A
<div lang="en">
## Hello
Hi **there**
- <div k="v">Yes</div><div k="w">No</div> sir
</div>
<div lang="ru">
Привет
</div>

<details><summary>transcriptions</summary>

{"lang":"en","hash":"fd536e66f9251","ipa":["həlˈəʊ","hˈaɪ ðˈeə",["jˈɛs sˈɜː","nˈəʊ sˈɜː"]]}
{"lang":"ru","hash":"0","ipa":["prʲivʲˈet"]}

</details>
"#;
	let drive = r#"
const hints = () => [...document.querySelectorAll('#canvas .body .said')].map(e => `${e.textContent}=${e.dataset.ipa}`).join('|');
const titleHint = () => document.querySelector('#canvas h2').dataset.ipa;
if (hints() !== 'Hi there=hˈaɪ ðˈeə|Yes sir=jˈɛs sˈɜː|No sir=nˈəʊ sˈɜː') throw new Error(`en: ${hints()}`);
if (titleHint() !== 'həlˈəʊ') throw new Error(`en title: ${titleHint()}`);
const s = [...document.querySelectorAll('#bar label.dim')].find(l => l.firstChild.textContent.trim() === 'language').querySelector('select'); s.value = 'ru'; s.dispatchEvent(new Event('change'));
if (hints() !== '') throw new Error(`the ru block changed since: ${hints()}`);
"#;
	check_save(&[], md, drive, &format!("[lang=\"ru\"]: #\n[layout=\"dfs\"]: #\n\n---\n\n{md}"));
}
