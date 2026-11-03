use std::{
	io::{Read, Write},
	net::TcpStream,
	path::Path,
	process::Command,
	time::{Duration, Instant},
};

fn build(test: &str, md: &str) -> Result<String, String> {
	let dir = std::env::temp_dir().join(format!("call_scripters_{test}_{}", std::process::id()));
	std::fs::create_dir_all(&dir).unwrap();
	let src = dir.join("script.md");
	std::fs::write(&src, md).unwrap();
	let out = Command::new(env!("CARGO_BIN_EXE_call_scripters"))
		.args(["build", "--direction", "horizontal"])
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
	let md = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo.md")).unwrap();
	let html = build("demo", &md).unwrap();
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
		let err = build("script_tag", md).unwrap_err();
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
	let dir = std::env::temp_dir().join(format!("call_scripters_watch_{}", std::process::id()));
	std::fs::create_dir_all(&dir).unwrap();
	let xdg_open = dir.join("xdg-open");
	std::fs::write(&xdg_open, format!("#!/bin/sh\necho \"$1\" > {}/url\n", dir.display())).unwrap();
	std::fs::set_permissions(&xdg_open, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
	let md = dir.join("script.md");
	std::fs::write(&md, "# One\n").unwrap();
	let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap());
	let mut child = Command::new(env!("CARGO_BIN_EXE_call_scripters")).arg("watch").arg(&md).env("PATH", path).spawn().unwrap();

	let started = Instant::now();
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
