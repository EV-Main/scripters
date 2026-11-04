// Sole parser of the script format: docs/spec/script_format.md

function parse(md) {
	const nodes = [];
	const labels = [];
	const errors = [];
	const langs = [];
	const dims = {};
	const marks = [];
	const preamble = { end: md.length, ruled: false }; // the lines before the first heading
	const lines = [];
	for (let start = 0; start < md.length; ) {
		const nl = md.indexOf('\n', start);
		const end = nl === -1 ? md.length : nl + 1;
		lines.push({ start, end, text: md.slice(start, end).replace(/\r?\n$/, '') });
		start = end;
	}

	let fence = null;
	let node = null;
	const scopes = []; // the open `<div k="v">`s, outermost first: {key, value, line}
	const scope = () => Object.fromEntries(scopes.map(s => [s.key, s.value]));
	lines.forEach((line, i) => {
		const lineNo = i + 1;
		const f = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.text.trim() === f[1]) fence = null;
		} else if (f) {
			fence = f[1];
		} else {
			const h = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/d.exec(line.text);
			const rule = /^ {0,3}-{3,}[ \t]*$/.test(line.text);
			if (preamble.end === md.length && h) preamble.end = line.start;
			else if (preamble.end === md.length && line.text.trim() !== '') preamble.ruled = rule;
			const noop = h?.[1]?.startsWith('-'); // groups sections when the md is read elsewhere
			if (noop && scopes.length) return;
			if (noop) {
				if (node) node.end = line.start;
				node = null;
				return;
			}
			if (h && scopes.length) {
				const t = heading(h[1] ?? '', 0, line.start, lineNo, errors);
				const lang = scope().lang;
				if (scopes.some(s => s.key !== 'lang')) return errors.push({ line: lineNo, msg: 'a heading inside a variant scope' });
				if (t.labels.length) errors.push({ line: lineNo, msg: 'labels go on the main heading' });
				if (lang in node.titles) errors.push({ line: lineNo, msg: `a second \`${lang}\` title` });
				else node.titles[lang] = t.title;
				return;
			}
			if (h) {
				if (node) node.end = line.start;
				node = heading(h[1] ?? '', line.start + (h.indices[1]?.[0] ?? line.text.length), line.start, lineNo, errors);
				nodes.push(node);
				return;
			}
			const r = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+\[([^\]]*)\]\(#([^)\s]+)\)[ \t]*$/.exec(line.text);
			if (r && node) {
				node.responses.push({ label: r[1], slot: decodeURIComponent(r[2]), scope: scope(), line: lineNo, start: line.start, end: line.end });
				return;
			}
			const d = /^ {0,3}<div ([\w-]+)="([\w-]+)">[ \t]*$/.exec(line.text);
			if (d && node) {
				const [, key, value] = d;
				if (scopes.some(s => s.key === key)) errors.push({ line: lineNo, msg: `\`<div ${key}>\` inside another` });
				scopes.push({ key, value, line: lineNo });
				const values = key === 'lang' ? langs : (dims[key] ??= []);
				if (!values.includes(value)) values.push(value);
				return;
			}
			if (scopes.length && /^ {0,3}<\/div>[ \t]*$/.test(line.text)) {
				scopes.pop();
				return;
			}
			// a link reference definition: invisible when the md is rendered elsewhere
			const l = /^\[([\w-]+)\]:[ \t]+<(oklch\(\d*\.?\d+ \d*\.?\d+ \d*\.?\d+\))>(?:[ \t]+"((?:[^"\\]|\\.)*)")?[ \t]*$/.exec(line.text);
			if (l && !node) {
				if (labels.some(d => d.name === l[1])) errors.push({ line: lineNo, msg: `label \`${l[1]}\` defined twice` });
				else labels.push({ name: l[1], color: l[2], description: (l[3] ?? '').replace(/\\(.)/g, '$1'), line: lineNo, start: line.start, end: line.end });
				return;
			}
			const m = /^\[(?:([\w-]+)=([\w-]+)|lang="([\w-]+)")\]:[ \t]+#[ \t]*$/.exec(line.text);
			if (m && !node) {
				const dim = m[1] ?? null;
				if (marks.some(k => k.dim === dim)) errors.push({ line: lineNo, msg: `a second mark for \`${dim ?? 'lang'}\`` });
				else marks.push({ dim, value: m[2] ?? m[3], line: lineNo, start: line.start, end: line.end });
				return;
			}
			if (rule && !node) return;
		}
		if (node) node.body.push({ text: line.text, scope: scope() });
		else if (line.text.trim() !== '') errors.push({ line: lineNo, msg: 'text outside any card' });
	});
	for (const s of scopes) errors.push({ line: s.line, msg: `\`<div ${s.key}="${s.value}">\` not closed` });
	if (node) node.end = md.length;
	if (nodes.length === 0 && errors.length === 0) errors.push({ line: 1, msg: 'no headings' });

	const byId = new Map();
	for (const n of nodes) {
		for (const l of n.labels) if (!labels.some(d => d.name === l)) errors.push({ line: n.line, msg: `unknown label \`.${l}\`` });
		if (byId.has(n.id)) errors.push({ line: n.line, msg: `duplicate of line ${byId.get(n.id).line}: same slot` });
		else byId.set(n.id, n);
	}

	const edges = [];
	for (const n of nodes) {
		for (const r of n.responses) {
			if (r.label.trim() === '' && n.responses.some(o => o !== r && Object.entries(o.scope).every(([k, v]) => (r.scope[k] ?? v) === v))) errors.push({ line: r.line, msg: "an unlabeled response must be its card's only one" });
			if (!byId.has(r.slot)) {
				errors.push({ line: r.line, msg: `response links to unknown slot #${r.slot}` });
				continue;
			}
			edges.push({ from: n.id, to: r.slot, label: r.label, scope: r.scope, start: r.start, end: r.end });
		}
		delete n.responses;
	}

	for (const vs of Object.values(dims)) vs.sort();
	const graph = { nodes, edges, labels, marks, preamble, langs, dims, errors, warnings: [] };
	if (errors.length === 0) {
		const reached = visible(graph, {});
		for (const n of nodes.filter(n => !reached.has(n.id))) {
			n.stray = true;
			graph.warnings.push({ line: n.line, msg: `"${n.title}" is unreachable from the first card` });
		}
	}

	for (const m of marks) if (!(m.dim === null ? langs : (dims[m.dim] ?? [])).includes(m.value)) errors.push({ line: m.line, msg: `no \`<div ${m.dim ?? 'lang'}="${m.value}">\`` });
	return graph;
}

// `at`: offset of `raw` in the md, so `attrs` can locate the `{…}` block
function heading(raw, at, start, line, errors) {
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
			errors.push({ line, msg: `\`${token}\` on a heading: variants are \`<div ${k}="${v}">\` scopes` });
		}
	}
	if (title === '') errors.push({ line, msg: 'empty heading' });
	// github's anchor slug, so slot links also resolve when the md is viewed there
	const id = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
	return { id, title, titles: {}, labels, attrs, line, start, end: null, body: [], responses: [], stray: false };
}

function visible(graph, selection) {
	const out = new Map();
	for (const e of graph.edges.filter(e => inScope(e, selection))) {
		if (!out.has(e.from)) out.set(e.from, []);
		out.get(e.from).push(e.to);
	}
	const seen = new Set();
	const stack = graph.nodes.filter((n, i) => i === 0 || n.stray).map(n => n.id); // strays still show, so they can be edited and linked
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...(out.get(id) ?? []));
	}
	return seen;
}

// a body line or edge in the selection: selection.variants is {dim: value}; a dim without a chosen value, or no selection.lang, admits every value
function inScope(item, selection) {
	return Object.entries(item.scope).every(([k, v]) => ((k === 'lang' ? selection.lang : selection.variants?.[k]) ?? v) === v);
}

if (typeof module !== 'undefined') module.exports = { parse, visible, inScope };
