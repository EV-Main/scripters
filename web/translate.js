// Fills one language of a script from another, one bit of prose at a time: docs/ARCHITECTURE.md#translating

if (typeof module !== 'undefined') var { parse } = require('./model.js');

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SCOPE = /^ {0,3}(?:<div [\w-]+="[\w-]+">|<\/div>)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const RESPONSE = /^( {0,3}(?:[-*+]|\d+[.)])[ \t]+\[)([^\]]*)(\]\(#[^)\s]+\)[ \t]*)$/;
const PREFIX = /^\s*((?:>\s*)*)([-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?/;

const split = s => s.replace(/\r?\n$/, '').split(/\r?\n/);
const depth = quote => quote.split('>').length;
const verbatim = line => line.trim() === '' || SCOPE.test(line) || RULE.test(line);

// a block's lines: verbatim strings, and `{before, text, after}` whose `text` is translated
function pieces(lines) {
	const out = [];
	let fence = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const f = FENCE.exec(line);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
			out.push(line);
			continue;
		}
		if (f) fence = f[1];
		if (f || verbatim(line)) {
			out.push(line);
			continue;
		}
		const r = RESPONSE.exec(line);
		if (r) {
			out.push(r[2] === '' ? line : { before: r[1], text: r[2], after: r[3], label: true });
			continue;
		}
		const [prefix, quote, marker] = PREFIX.exec(line);
		const parts = [line.slice(prefix.length).trim()];
		while (!marker?.startsWith('#') && i + 1 < lines.length) {
			const next = lines[i + 1];
			if (FENCE.test(next) || verbatim(next) || RESPONSE.test(next)) break;
			const [p, q, m] = PREFIX.exec(next);
			if (m !== undefined || depth(q) !== depth(quote)) break;
			parts.push(next.slice(p.length).trim());
			i++;
		}
		const text = parts.join(' ');
		out.push(text === '' ? line : { before: prefix, text, after: '' });
	}
	return out;
}

// every `from` block and where its `to` sibling goes: {key, title, at, wrap, old, pieces, heading}
function blocks(md, from, to) {
	if (from === to) throw new Error(`translating \`${from}\` into itself`);
	const graph = parse(md);
	if (graph.errors.length) throw new Error(graph.errors.map(e => `line ${e.line}: ${e.msg}`).join('\n'));
	const errors = [];
	const out = [];
	for (const node of graph.nodes) {
		const nl = md.indexOf('\n', node.start);
		const bodyStart = nl === -1 ? md.length : nl + 1;
		const level = /^ {0,3}(#+)/.exec(md.slice(node.start, bodyStart))[1].length;
		const heading = `${'#'.repeat(Math.min(level + 1, 6))} `;
		const push = (b, i, titled) => out.push({ key: i === 0 ? node.id : `${node.id}@${i + 1}`, title: node.title, heading: titled && !b.lines.some(l => HEADING.test(l)) ? heading : null, pieces: pieces(b.lines), ...b });
		if (node.langs.length === 0) {
			const body = md.slice(bodyStart, node.end);
			const last = body.trimEnd().length;
			if (last === 0) {
				push({ at: bodyStart, wrap: null, old: null, lines: [] }, 0, true);
				continue;
			}
			const end = body.indexOf('\n', last);
			const lines = split(body.slice(0, end === -1 ? body.length : end + 1));
			const open = `<div lang="${from}">\n${lines[0].trim() === '' ? '' : '\n'}`; // a blank line, so the md inside renders as md elsewhere
			if (lines[0].trim() !== '') lines.unshift('');
			push({ at: end === -1 ? node.end : bodyStart + end + 1, wrap: { at: bodyStart, open }, old: null, lines }, 0, true);
			continue;
		}
		const group = s => JSON.stringify(s.scope);
		const bases = node.langs.filter(s => s.lang === from);
		const titled = bases.find(s => Object.keys(s.scope).length === 0); // a title inside a variant is an error
		for (const g of new Set(node.langs.map(group))) {
			const [b, t] = [from, to].map(lang => node.langs.filter(s => s.lang === lang && group(s) === g).length);
			const within = g === '{}' ? '' : ` within ${g}`;
			if (b === 0) errors.push(`#${node.id}: no \`${from}\` block${within}`);
			else if (t !== 0 && t !== b) errors.push(`#${node.id}: ${b} \`${from}\` blocks but ${t} \`${to}\`${within}`);
		}
		bases.forEach((s, i) => {
			const nth = bases.slice(0, i).filter(o => group(o) === group(s)).length;
			const old = node.langs.filter(o => o.lang === to && group(o) === group(s))[nth] ?? null;
			push({ at: s.end, wrap: null, old, lines: split(md.slice(s.start, s.end)).slice(1, -1) }, i, s === titled);
		});
	}
	if (errors.length) throw new Error(errors.join('\n'));
	return out;
}

// the texts to translate, each once
function bits(md, from, to) {
	const texts = new Set();
	for (const b of blocks(md, from, to)) {
		if (b.heading) texts.add(b.title);
		for (const p of b.pieces) if (typeof p !== 'string') texts.add(p.text);
	}
	return [...texts];
}

// `map`: {text → translation} for every one of `bits`; `overwrite`: keys of the conflicts to resolve with the translation
function apply(md, from, to, map, overwrite) {
	const tr = text => {
		if (!(text in map)) throw new Error(`no translation of ${JSON.stringify(text)}`);
		return map[text];
	};
	const edits = [];
	const conflicts = [];
	const errors = [];
	for (const b of blocks(md, from, to)) {
		const lines = b.pieces.map(p => {
			if (typeof p === 'string') return p;
			const t = tr(p.text);
			if (p.label && /[[\]]/.test(t)) errors.push(`#${b.key}: the translation of the response \`${p.text}\` holds a bracket: ${t}`);
			return p.before + t + p.after;
		});
		if (b.heading) lines.splice(Math.max(0, lines.findIndex(l => l.trim() !== '')), 0, b.heading + tr(b.title));
		const block = [`<div lang="${to}">`, ...lines, '</div>', ''].join('\n');
		if (b.old) {
			const old = md.slice(b.old.start, b.old.end);
			if (old.trimEnd() === block.trimEnd()) continue;
			if (overwrite.includes(b.key)) edits.push({ start: b.old.start, end: b.old.end, text: block });
			else conflicts.push({ key: b.key, title: b.title, old, new: block });
			continue;
		}
		if (b.wrap !== null) edits.push({ start: b.wrap.at, end: b.wrap.at, text: b.wrap.open });
		edits.push({ start: b.at, end: b.at, text: (b.wrap === null ? '' : '</div>\n') + block });
	}
	if (errors.length) throw new Error(errors.join('\n'));
	let out = md;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		const text = e.start > 0 && out[e.start - 1] !== '\n' ? `\n${e.text}` : e.text; // the md ends without a newline
		out = out.slice(0, e.start) + text + out.slice(e.end);
	}
	const errs = parse(out).errors;
	if (errs.length) throw new Error(`the translated md does not parse:\n${errs.map(e => `line ${e.line}: ${e.msg}`).join('\n')}`);
	return { md: out, conflicts };
}

if (typeof module !== 'undefined') module.exports = { bits, apply };
