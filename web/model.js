// Sole parser of the script format: docs/spec/script_format.md

function parse(md) {
	const nodes = [];
	const labels = [];
	const errors = [];
	const langs = [];
	const lines = [];
	for (let start = 0; start < md.length; ) {
		const nl = md.indexOf('\n', start);
		const end = nl === -1 ? md.length : nl + 1;
		lines.push({ start, end, text: md.slice(start, end).replace(/\r?\n$/, '') });
		start = end;
	}

	let fence = null;
	let node = null;
	let lang = null; // the open `<div lang>`: {code, line}
	lines.forEach((line, i) => {
		const lineNo = i + 1;
		const f = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.text.trim() === f[1]) fence = null;
		} else if (f) {
			fence = f[1];
		} else {
			const h = /^ {0,3}#(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/d.exec(line.text);
			if (h && lang) {
				const t = heading(h[1] ?? '', 0, line.start, lineNo, errors);
				if (Object.keys(t.tags).length || t.labels.length) errors.push({ line: lineNo, msg: 'tags and labels go on the main heading' });
				if (lang.code in node.titles) errors.push({ line: lineNo, msg: `a second \`${lang.code}\` title` });
				else node.titles[lang.code] = t.title;
				return;
			}
			if (h) {
				if (node) node.end = line.start;
				node = heading(h[1] ?? '', line.start + (h.indices[1]?.[0] ?? line.text.length), line.start, lineNo, errors);
				nodes.push(node);
				return;
			}
			const r = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+\[([^\]]+)\]\(#([^)\s]+)\)[ \t]*$/.exec(line.text);
			if (r && node) {
				node.responses.push({ label: r[1], slot: decodeURIComponent(r[2]), lang: lang?.code ?? null, line: lineNo, start: line.start, end: line.end });
				return;
			}
			const d = /^ {0,3}<div lang="([\w-]+)">[ \t]*$/.exec(line.text);
			if (d && node) {
				if (lang) errors.push({ line: lineNo, msg: '`<div lang>` inside another' });
				lang = { code: d[1], line: lineNo };
				if (!langs.includes(d[1])) langs.push(d[1]);
				return;
			}
			if (lang && /^ {0,3}<\/div>[ \t]*$/.test(line.text)) {
				lang = null;
				return;
			}
			// a link reference definition: invisible when the md is rendered elsewhere
			const l = /^\[([\w-]+)\]:[ \t]+<(oklch\(\d*\.?\d+ \d*\.?\d+ \d*\.?\d+\))>(?:[ \t]+"((?:[^"\\]|\\.)*)")?[ \t]*$/.exec(line.text);
			if (l && !node) {
				if (labels.some(d => d.name === l[1])) errors.push({ line: lineNo, msg: `label \`${l[1]}\` defined twice` });
				else labels.push({ name: l[1], color: l[2], description: (l[3] ?? '').replace(/\\(.)/g, '$1'), line: lineNo, start: line.start, end: line.end });
				return;
			}
		}
		if (node) node.body.push({ text: line.text, lang: lang?.code ?? null });
		else if (line.text.trim() !== '') errors.push({ line: lineNo, msg: 'text before the first `# ` heading' });
	});
	if (lang) errors.push({ line: lang.line, msg: `\`<div lang="${lang.code}">\` not closed` });
	if (node) node.end = md.length;
	if (nodes.length === 0 && errors.length === 0) errors.push({ line: 1, msg: 'no `# ` headings' });

	const byId = new Map();
	const slots = new Map();
	for (const n of nodes) {
		for (const l of n.labels) if (!labels.some(d => d.name === l)) errors.push({ line: n.line, msg: `unknown label \`.${l}\`` });
		if (byId.has(n.id)) errors.push({ line: n.line, msg: `duplicate of line ${byId.get(n.id).line}: same heading and tags` });
		byId.set(n.id, n);
		if (!slots.has(n.slot)) slots.set(n.slot, []);
		slots.get(n.slot).push(n);
	}

	const edges = [];
	const entered = new Set();
	for (const n of nodes) {
		for (const r of n.responses) {
			const targets = slots.get(r.slot);
			if (!targets) {
				errors.push({ line: r.line, msg: `response links to unknown slot #${r.slot}` });
				continue;
			}
			entered.add(r.slot);
			for (const t of targets) edges.push({ from: n.id, to: t.id, label: r.label, lang: r.lang, start: r.start, end: r.end });
		}
		delete n.responses;
	}
	for (const n of nodes) n.root = !entered.has(n.slot);

	const graph = { nodes, edges, labels, langs, dims: {}, errors };
	if (errors.length === 0) {
		const reached = visible(graph, {});
		for (const n of nodes) if (!reached.has(n.id)) errors.push({ line: n.line, msg: `"${n.title}" is unreachable from any root` });
	}

	for (const n of nodes) {
		for (const [k, v] of Object.entries(n.tags)) {
			graph.dims[k] ??= [];
			if (!graph.dims[k].includes(v)) graph.dims[k].push(v);
		}
	}
	for (const vs of Object.values(graph.dims)) vs.sort();
	return graph;
}

// `at`: offset of `raw` in the md, so `attrs` can locate the `{…}` block
function heading(raw, at, start, line, errors) {
	const tags = {};
	const labels = [];
	let title = raw.trim();
	const attrs = { start: at + title.length, end: at + title.length };
	const t = /\s*\{\s*((?:[\w-]+=[\w-]+|\.[\w-]+)(?:\s+(?:[\w-]+=[\w-]+|\.[\w-]+))*)\s*\}$/.exec(title);
	if (t) {
		title = title.slice(0, t.index);
		attrs.start = at + t.index;
		for (const token of t[1].split(/\s+/)) {
			if (token.startsWith('.')) {
				if (labels.includes(token.slice(1))) errors.push({ line, msg: `label \`${token}\` given twice` });
				else labels.push(token.slice(1));
				continue;
			}
			const [k, v] = token.split('=');
			if (k in tags) errors.push({ line, msg: `tag key \`${k}\` given twice` });
			tags[k] = v;
		}
	}
	if (title === '') errors.push({ line, msg: 'empty heading' });
	// github's anchor slug, so slot links also resolve when the md is viewed there
	const slot = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
	const keys = Object.keys(tags).sort();
	const id = keys.length ? `${slot}{${keys.map(k => `${k}=${tags[k]}`).join(' ')}}` : slot;
	return { id, slot, title, titles: {}, tags, labels, attrs, line, start, end: null, body: [], responses: [] };
}

// selection.variants: {dim: value}; a dim without a chosen value admits every variant. No selection.lang admits every language
function visible(graph, selection) {
	const chosen = selection.variants ?? {};
	const admits = n => Object.entries(n.tags).every(([k, v]) => !(k in chosen) || chosen[k] === v);
	const out = new Map();
	for (const e of graph.edges.filter(e => inLang(e, selection))) {
		if (!out.has(e.from)) out.set(e.from, []);
		out.get(e.from).push(e.to);
	}
	const byId = new Map(graph.nodes.map(n => [n.id, n]));
	const seen = new Set();
	const stack = graph.nodes.filter(n => n.root && admits(n)).map(n => n.id);
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		for (const to of out.get(id) ?? []) if (admits(byId.get(to))) stack.push(to);
	}
	return seen;
}

// a body line or edge, scoped to `item.lang` or to none
function inLang(item, selection) {
	return !item.lang || !selection.lang || item.lang === selection.lang;
}

if (typeof module !== 'undefined') module.exports = { parse, visible, inLang };
