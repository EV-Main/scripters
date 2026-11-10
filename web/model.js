// Sole parser of the script format: docs/ARCHITECTURE.md#format

const LAYOUTS = ['dfs', 'bfs']; // implemented in web/layout.js
const INLINE = /<div ([\w-]+)="([\w-]+)">(.*?)<\/div>/g;
// var: web/translate.js imports these with `var`, and the CLI evaluates both in one scope
var TRANSCRIPTIONS = '<details><summary>transcriptions</summary>';
var PREFIX = /^\s*((?:>\s*)*)([-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?/; // a line's quote, list and heading markers
var TIME = /^ {0,3}⏱[ \t]*(\d+(?:\.\d+)?)[ \t]*min[ \t]*$/;

function parse(md) {
	const nodes = [];
	const labels = [];
	const errors = [];
	const langs = [];
	const dims = {};
	const marks = [];
	const preamble = { end: md.length, ruled: false }; // the lines before the first heading
	let transcriptions = null; // {entries, start, end}; `end` is null while open
	const lines = [];
	for (let start = 0; start < md.length; ) {
		const nl = md.indexOf('\n', start);
		const end = nl === -1 ? md.length : nl + 1;
		lines.push({ start, end, text: md.slice(start, end).replace(/\r?\n$/, '') });
		start = end;
	}

	let fence = null;
	let node = null;
	const scopes = []; // the open `<div k="v">`s, outermost first: {key, value, line, block}; a block one holds whole sections
	const scope = block => Object.fromEntries(scopes.filter(s => s.block === block).map(s => [s.key, s.value]));
	const inCard = () => scopes.some(s => !s.block);
	lines.forEach((line, i) => {
		const lineNo = i + 1;
		if (transcriptions?.end === null) {
			if (/^<\/details>[ \t]*$/.test(line.text)) transcriptions.end = line.end;
			else if (line.text.trim() !== '') {
				let e = null;
				try {
					e = JSON.parse(line.text);
				} catch {} // reported below, with what a line must hold
				const ipa = v => v === null || typeof v === 'string';
				const valid = typeof e?.lang === 'string' && typeof e.hash === 'string' && Array.isArray(e.ipa) && e.ipa.every(v => ipa(v) || (Array.isArray(v) && v.every(ipa)));
				if (!valid) errors.push({ line: lineNo, msg: 'a transcription is a {"lang", "hash", "ipa": [per line of the block: ipa, null, or [per inline variant: ipa or null]]} json line' });
				else if (transcriptions.entries.some(o => o.lang === e.lang && o.hash === e.hash)) errors.push({ line: lineNo, msg: `a second \`${e.lang}\` transcription of one block` });
				else transcriptions.entries.push(e);
			}
			return;
		}
		const f = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.text.trim() === f[1]) fence = null;
		} else if (f) {
			fence = f[1];
		} else {
			const h = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/d.exec(line.text);
			const rule = /^ {0,3}-{3,}[ \t]*$/.test(line.text);
			const d = /^ {0,3}<div ([\w-]+)="([\w-]+)">[ \t]*$/.exec(line.text);
			const block = d !== null && d[1] !== 'lang' && !inCard() && (!node || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(lines.find((l, j) => j > i && l.text.trim() !== '')?.text ?? ''));
			if (preamble.end === md.length && (h || block)) preamble.end = line.start;
			else if (preamble.end === md.length && line.text.trim() !== '') preamble.ruled = rule;
			if (line.text.trimEnd() === TRANSCRIPTIONS && !scopes.length) {
				if (transcriptions) errors.push({ line: lineNo, msg: 'a second transcriptions block' });
				transcriptions = { entries: [], start: line.start, end: null };
				if (node) node.end = line.start;
				node = null;
				return;
			}
			const noop = h?.[1]?.startsWith('-'); // groups sections when the md is read elsewhere
			if (noop && inCard()) return;
			if (noop) {
				if (node) node.end = line.start;
				node = null;
				return;
			}
			if (h && inCard()) {
				const t = heading(h[1] ?? '', 0, line.start, lineNo, errors);
				const lang = scope(false).lang;
				if (scopes.some(s => !s.block && s.key !== 'lang')) return errors.push({ line: lineNo, msg: 'a heading inside a variant scope' });
				if (t.labels.length) errors.push({ line: lineNo, msg: 'labels go on the main heading' });
				if (lang in node.titles) errors.push({ line: lineNo, msg: `a second \`${lang}\` title` });
				else node.titles[lang] = t.title;
				const block = scopes.find(s => s.key === 'lang').lang;
				block.title = lineNo;
				block.reads.push({ text: t.title, line: lineNo, combo: null });
				return;
			}
			if (h) {
				if (node) node.end = line.start;
				node = heading(h[1] ?? '', line.start + (h.indices[1]?.[0] ?? line.text.length), line.start, lineNo, errors);
				node.scope = scope(true);
				nodes.push(node);
				return;
			}
			const r = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+\[([^\]]*)\]\(#([^)\s]+)\)[ \t]*$/.exec(line.text);
			if (r && node) {
				node.responses.push({ label: r[1], slot: decodeURIComponent(r[2]), scope: scope(false), line: lineNo, start: line.start, end: line.end });
				return;
			}
			if (d && (node || block)) {
				const [, key, value] = d;
				if (block && node) node.end = line.start;
				if (block) node = null;
				if (scopes.some(s => s.key === key)) errors.push({ line: lineNo, msg: `\`<div ${key}>\` inside another` });
				scopes.push({ key, value, line: lineNo, start: line.start, block, lang: key === 'lang' ? { lang: value, line: lineNo, title: null, reads: [] } : null }); // `lang`: the block's lines web/translate.js reads
				const values = key === 'lang' ? langs : (dims[key] ??= []);
				if (!values.includes(value)) values.push(value);
				return;
			}
			if (scopes.length && /^ {0,3}<\/div>[ \t]*$/.test(line.text)) {
				const s = scopes.pop();
				if (s.key === 'lang') node.langs.push(Object.assign(s.lang, { scope: scope(false), start: s.start, end: line.end, hash: digest(md.slice(s.start, line.end)), ipa: null }));
				if (s.block && node) {
					node.end = line.start;
					node = null;
				}
				return;
			}
			// a link reference definition: invisible when the md is rendered elsewhere
			const l = /^\[([\w-]+)\]:[ \t]+<(oklch\(\d*\.?\d+ \d*\.?\d+ \d*\.?\d+\))>(?:[ \t]+"((?:[^"\\]|\\.)*)")?[ \t]*$/.exec(line.text);
			if (l && !node) {
				if (labels.some(d => d.name === l[1])) errors.push({ line: lineNo, msg: `label \`${l[1]}\` defined twice` });
				else labels.push({ name: l[1], color: l[2], description: (l[3] ?? '').replace(/\\(.)/g, '$1'), line: lineNo, start: line.start, end: line.end });
				return;
			}
			const m = /^\[(?:([\w-]+)=([\w-]+)|(lang|layout)="([\w-]+)")\]:[ \t]+#[ \t]*$/.exec(line.text);
			if (m && !node) {
				const [dim, setting] = [m[1] ?? null, m[3] ?? null];
				if (marks.some(k => k.dim === dim && k.setting === setting)) errors.push({ line: lineNo, msg: `a second mark for \`${dim ?? setting}\`` });
				else marks.push({ dim, setting, value: m[2] ?? m[4], line: lineNo, start: line.start, end: line.end });
				return;
			}
			if (rule && !node) return;
			const spans = [...line.text.matchAll(INLINE)];
			if (spans.length && node) {
				const split = {}; // key → its values on this line
				for (const [, key, value] of spans) {
					if (!(key in split) && scopes.some(s => s.key === key)) errors.push({ line: lineNo, msg: `\`<div ${key}>\` inside another` });
					if (!(split[key] ??= []).includes(value)) split[key].push(value);
					const values = key === 'lang' ? langs : (dims[key] ??= []);
					if (!values.includes(value)) values.push(value);
				}
				let combos = [{}];
				for (const [key, values] of Object.entries(split)) combos = combos.flatMap(c => values.map(v => ({ ...c, [key]: v })));
				const lang = scopes.find(s => s.key === 'lang')?.lang ?? null;
				combos.forEach((c, combo) => {
					const l = { text: line.text.replace(INLINE, (_, key, value, text) => (c[key] === value ? text : '')), scope: { ...scope(false), ...c }, line: lineNo, lang, combo };
					const t = TIME.exec(l.text);
					if (t) return node.times.push({ min: Number(t[1]), scope: l.scope, line: lineNo });
					node.body.push(l);
					lang?.reads.push(l);
				});
				return;
			}
		}
		const t = !fence && TIME.exec(line.text);
		if (t && node) node.times.push({ min: Number(t[1]), scope: scope(false), line: lineNo });
		else if (node) {
			const l = { text: line.text, scope: scope(false), line: lineNo, lang: scopes.find(s => s.key === 'lang')?.lang ?? null, combo: null };
			node.body.push(l);
			if (!fence && !f) l.lang?.reads.push(l); // code is not read aloud
		} else if (line.text.trim() !== '') errors.push({ line: lineNo, msg: 'text outside any card' });
	});
	for (const s of scopes) errors.push({ line: s.line, msg: `\`<div ${s.key}="${s.value}">\` not closed` });
	if (transcriptions?.end === null) errors.push({ line: md.slice(0, transcriptions.start).split('\n').length, msg: 'transcriptions block not closed' });
	for (const b of nodes.flatMap(n => n.langs)) b.ipa = transcriptions?.entries.find(e => e.lang === b.lang && e.hash === b.hash)?.ipa ?? null;
	if (node) node.end = md.length;

	const byId = new Map();
	for (const n of nodes) {
		for (const l of n.labels) if (!labels.some(d => d.name === l)) errors.push({ line: n.line, msg: `unknown label \`.${l}\`` });
		if (byId.has(n.id)) errors.push({ line: n.line, msg: `duplicate of line ${byId.get(n.id).line}: same slot` });
		else byId.set(n.id, n);
	}

	const agree = (a, b) => Object.entries(a.scope).every(([k, v]) => (b.scope[k] ?? v) === v); // some selection admits both
	const edges = [];
	for (const n of nodes) {
		n.times.forEach((t, i) => n.times.slice(0, i).some(o => agree(o, t)) && errors.push({ line: t.line, msg: 'a second time for one card' }));
		for (const r of n.responses) {
			if (r.label.trim() === '' && n.responses.some(o => o !== r && agree(o, r))) errors.push({ line: r.line, msg: "an unlabeled response must be its card's only one" });
			if (!byId.has(r.slot)) {
				errors.push({ line: r.line, msg: `response links to unknown slot #${r.slot}` });
				continue;
			}
			edges.push({ from: n.id, to: r.slot, label: r.label, scope: r.scope, start: r.start, end: r.end });
		}
		delete n.responses;
	}

	for (const vs of Object.values(dims)) vs.sort();
	const graph = { nodes, edges, labels, marks, preamble, langs, dims, transcriptions, errors, warnings: [] };
	if (errors.length === 0) {
		const reached = visible(graph, {});
		for (const n of nodes.filter(n => !reached.has(n.id))) {
			n.stray = true;
			graph.warnings.push({ line: n.line, msg: `"${n.title}" is unreachable from the first card` });
		}
	}

	for (const m of marks) {
		if (m.setting === 'layout' && !LAYOUTS.includes(m.value)) errors.push({ line: m.line, msg: `no layout \`${m.value}\`: ${LAYOUTS.map(l => `\`${l}\``).join(' or ')}` });
		else if (m.setting !== 'layout' && !(m.dim === null ? langs : (dims[m.dim] ?? [])).includes(m.value)) errors.push({ line: m.line, msg: `no \`<div ${m.dim ?? 'lang'}="${m.value}">\`` });
	}
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
	return { id, title, titles: {}, langs: [], labels, attrs, line, start, end: null, body: [], times: [], responses: [], stray: false };
}

// cyrb53: keys a block's transcription to its text
function digest(s) {
	let [a, b] = [0xdeadbeef, 0x41c6ce57];
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		a = Math.imul(a ^ c, 2654435761);
		b = Math.imul(b ^ c, 1597334677);
	}
	a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
	b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
	return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16);
}

function visible(graph, selection) {
	const out = new Map();
	for (const e of graph.edges.filter(e => inScope(e, selection))) {
		if (!out.has(e.from)) out.set(e.from, []);
		out.get(e.from).push(e.to);
	}
	const admitted = new Set(graph.nodes.filter(n => inScope(n, selection)).map(n => n.id));
	const seen = new Set();
	const stack = graph.nodes.filter((n, i) => i === 0 || n.stray).map(n => n.id); // strays still show, so they can be edited and linked
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id) || !admitted.has(id)) continue;
		seen.add(id);
		stack.push(...(out.get(id) ?? []));
	}
	return seen;
}

// a body line or edge in the selection: selection.variants is {dim: value}; a dim without a chosen value, or no selection.lang, admits every value
function inScope(item, selection) {
	return Object.entries(item.scope).every(([k, v]) => ((k === 'lang' ? selection.lang : selection.variants?.[k]) ?? v) === v);
}

if (typeof module !== 'undefined') module.exports = { LAYOUTS, TRANSCRIPTIONS, PREFIX, TIME, parse, visible, inScope };
