use std::{path::Path, process::Command};

fn build(test: &str, md: &str) -> Result<String, String> {
	let dir = std::env::temp_dir().join(format!("call_scripters_{test}_{}", std::process::id()));
	std::fs::create_dir_all(&dir).unwrap();
	let src = dir.join("script.md");
	std::fs::write(&src, md).unwrap();
	let out = Command::new(env!("CARGO_BIN_EXE_call_scripters")).args(["--direction", "horizontal"]).arg(&src).output().unwrap();
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
