use std::{
	io::{Read, Write},
	net::TcpStream,
	path::Path,
	process::Command,
	time::{Duration, Instant},
};

fn build(test: &str, flags: &[&str], md: &str) -> Result<String, String> {
	let dir = std::env::temp_dir().join(format!("scripters_{test}_{}", std::process::id()));
	std::fs::create_dir_all(&dir).unwrap();
	let src = dir.join("script.md");
	std::fs::write(&src, md).unwrap();
	let out = Command::new(env!("CARGO_BIN_EXE_scripters"))
		.args(["build", "--direction", "horizontal"])
		.args(flags)
		.arg(&src)
		.arg("-o")
		.arg(dir.join("script.html"))
		.output()
		.unwrap();
	let result = match out.status.success() {
		true => Ok(std::fs::read_to_string(dir.join("script.html")).unwrap()),
		false => Err(String::from_utf8(out.stderr).unwrap()),
	};
	std::fs::remove_dir_all(&dir).unwrap();
	result
}

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
		"{method} {path} HTTP/1.1\r\nHost: {host}\r\n{if_match}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
		body.len()
	)
	.unwrap();
	let mut response = String::new();
	stream.read_to_string(&mut response).unwrap();
	let (head, body) = response.split_once("\r\n\r\n").unwrap();
	(head.split(' ').nth(1).unwrap().parse().unwrap(), body.to_owned())
}

#[test]
fn watch_serves_the_md_on_disk_and_writes_page_saves_back() {
	let dir = std::env::temp_dir().join(format!("scripters_watch_{}", std::process::id()));
	std::fs::create_dir_all(&dir).unwrap();
	let xdg_open = dir.join("xdg-open");
	std::fs::write(&xdg_open, format!("#!/bin/sh\necho \"$1\" > {}/url\n", dir.display())).unwrap();
	std::fs::set_permissions(&xdg_open, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
	let md = dir.join("script.md");
	std::fs::write(&md, "# One\n").unwrap();
	let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap());
	let mut child = Command::new(env!("CARGO_BIN_EXE_scripters")).arg("watch").arg(&md).env("PATH", path).spawn().unwrap();

	let started = Instant::now();
	//LOOP: bounded by the 10s assert
	let url = loop {
		if let Ok(url) = std::fs::read_to_string(dir.join("url"))
			&& url.ends_with('\n')
		{
			break url;
		}
		assert!(started.elapsed() < Duration::from_secs(10), "watch never opened a url");
		std::thread::sleep(Duration::from_millis(20));
	};
	let addr = url.trim().strip_prefix("http://").unwrap().trim_end_matches('/').to_owned();
	let get = |path| request(&addr, &addr, "GET", path, None, "");
	let put = |if_match: &str, body| request(&addr, &addr, "PUT", "/", Some(if_match), body);

	let (status, page) = get("/");
	assert_eq!(status, 200);
	assert!(page.contains("# One") && page.contains("data-live="), "{page}");
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
	std::fs::remove_dir_all(&dir).unwrap();
}

/// The page built from `md` with `flags` runs `drive`, then its Export ▾ .md must download `expected`
#[track_caller]
fn check_save(flags: &[&str], md: &str, drive: &str, expected: &str) {
	let html = build("save", flags, md).unwrap();
	let dir = std::env::temp_dir().join(format!("scripters_save_page_{}_{:?}", std::process::id(), std::thread::current().id()));
	std::fs::create_dir_all(&dir).unwrap();
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
	let page = dir.join("script.html");
	std::fs::write(&page, html.replacen("</body>", &capture, 1)).unwrap();
	let browser = ["chromium", "chromium-browser", "google-chrome"]
		.into_iter()
		.find(|b| Command::new(b).arg("--version").output().is_ok_and(|o| o.status.success()))
		.expect("a chromium on PATH");
	let out = Command::new(browser)
		.args(["--headless", "--disable-gpu", "--no-first-run", "--no-sandbox", "--dump-dom"])
		.arg(format!("--user-data-dir={}", dir.join("profile").display()))
		.arg(format!("file://{}", page.display()))
		.output()
		.unwrap();
	std::fs::remove_dir_all(&dir).unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	let dom = String::from_utf8(out.stdout).unwrap();
	let (_, rest) = dom
		.split_once(r#"<script type="text/plain" id="saved">"#)
		.unwrap_or_else(|| panic!("the page never saved:\n{dom}"));
	assert_eq!(rest.split_once("</script>").unwrap().0, expected);
}

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
	check_save(&["--bfs"], "# A\n", "", bfs);
	check_save(&["--bfs"], "[layout=\"dfs\"]: #\n\n---\n\n# A\n", "", bfs);
	let pick = "const s = [...document.querySelectorAll('#bar label.dim')].find(l => l.firstChild.textContent.trim() === 'layout').querySelector('select'); s.value = 'bfs'; s.dispatchEvent(new Event('change'));";
	check_save(&[], "# A\n", pick, bfs);
}

#[test]
fn following_a_variant_response_chooses_its_variant() {
	let md = "# A\n<div k=\"v\">\n- [x](#b)\n</div>\n<div k=\"w\">\n- [y](#b)\n</div>\n# B\n";
	let follow = "[...document.querySelectorAll('#canvas button.label')].find(b => b.textContent === 'k=wy').click();";
	check_save(&[], md, follow, &format!("[k=w]: #\n[layout=\"dfs\"]: #\n\n---\n\n{md}"));
}
