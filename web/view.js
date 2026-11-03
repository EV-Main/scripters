const KEY = `call_scripters:${document.title}`;
const DOUBLE_CLICK_MS = 400;
const SCRIPT_TAG = /<\/?script/i; // would end or nest the embedding <script> block
const pristine = document.documentElement.outerHTML;
const bar = document.getElementById('bar');
const canvas = document.getElementById('canvas');

let md = document.getElementById('src').textContent;
let graph = parse(md);
let sel = JSON.parse(sessionStorage.getItem(KEY) ?? '{"variants":{},"path":[]}');
let dirty = false;
let editing = null;
let lastClick = { id: null, t: 0 };
let revealing = null;
let cards = new Map();

function el(tag, cls, html) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (html !== undefined) e.innerHTML = html;
	return e;
}

function render() {
	const ids = new Set(graph.nodes.map(n => n.id));
	sel.path = sel.path.filter(id => ids.has(id));
	for (const [k, v] of Object.entries(sel.variants)) if (!graph.dims[k]?.includes(v)) delete sel.variants[k];
	sessionStorage.setItem(KEY, JSON.stringify(sel));

	renderBar();
	canvas.replaceChildren();
	cards = new Map();
	if (graph.errors.length) {
		canvas.append(errorList(graph.errors, e => `line ${e.line}: ${e.msg}`));
		canvas.style.width = canvas.style.height = '';
		return;
	}

	const shown = visible(graph, sel);
	const nodes = graph.nodes.filter(n => shown.has(n.id));
	const edges = graph.edges.filter(e => shown.has(e.from) && shown.has(e.to));
	const current = sel.path.at(-1);
	const walked = new Set(sel.path.slice(1).map((id, i) => `${sel.path[i]}\n${id}`));

	for (const n of nodes) {
		const card = el('article', 'card');
		card.dataset.id = n.id;
		card.classList.toggle('visited', sel.path.includes(n.id));
		card.classList.toggle('current', n.id === current);
		const head = el('header');
		for (const [k, v] of Object.entries(n.tags)) head.append(el('span', 'chip', `${k}=${v}`));
		head.append(el('h2', '', marked.parseInline(n.title)));
		card.append(head, el('div', 'body', marked.parse(n.body)));
		card.addEventListener('click', () => click(n));
		canvas.append(card);
		cards.set(n.id, card);
	}
	const labels = edges.map(e => {
		const label = el('button', 'label', marked.parseInline(e.label));
		label.classList.toggle('visited', walked.has(`${e.from}\n${e.to}`));
		label.addEventListener('click', () => {
			if (editing) return;
			go(e.to, e.from);
			reveal(e.to);
		});
		canvas.append(label);
		return label;
	});

	const g = new dagre.graphlib.Graph({ multigraph: true });
	g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 120, edgesep: 16, marginx: 48, marginy: 48 });
	for (const n of nodes) g.setNode(n.id, { width: cards.get(n.id).offsetWidth, height: cards.get(n.id).offsetHeight });
	edges.forEach((e, i) => g.setEdge(e.from, e.to, { width: labels[i].offsetWidth, height: labels[i].offsetHeight, labelpos: 'c' }, String(i)));
	dagre.layout(g);

	for (const n of nodes) {
		const { x, y, width, height } = g.node(n.id);
		Object.assign(cards.get(n.id).style, { left: `${x - width / 2}px`, top: `${y - height / 2}px` });
	}
	const { width, height } = g.graph();
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('width', width);
	svg.setAttribute('height', height);
	svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>';
	edges.forEach((e, i) => {
		const { points, x, y } = g.edge(e.from, e.to, String(i));
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		let d = `M${points[0].x},${points[0].y}`;
		for (let j = 1; j < points.length - 1; j++) {
			const [p, q] = [points[j], points[j + 1]];
			d += ` Q${p.x},${p.y} ${(p.x + q.x) / 2},${(p.y + q.y) / 2}`;
		}
		d += ` L${points.at(-1).x},${points.at(-1).y}`;
		path.setAttribute('d', d);
		path.setAttribute('marker-end', 'url(#arrow)');
		path.classList.toggle('visited', walked.has(`${e.from}\n${e.to}`));
		svg.append(path);
		Object.assign(labels[i].style, { left: `${x - labels[i].offsetWidth / 2}px`, top: `${y - labels[i].offsetHeight / 2}px` });
	});
	canvas.prepend(svg);
	Object.assign(canvas.style, { width: `${width}px`, height: `${height}px` });
}

function renderBar() {
	bar.replaceChildren(el('strong', 'title', document.title));
	if (dirty) bar.append(el('span', 'dirty', '● unsaved'));
	for (const [dim, values] of Object.entries(graph.dims)) {
		const select = el('select');
		for (const v of ['all', ...values]) select.append(new Option(v, v, false, sel.variants[dim] === v));
		if (!(dim in sel.variants)) select.value = 'all';
		select.addEventListener('change', () => {
			if (select.value === 'all') delete sel.variants[dim];
			else sel.variants[dim] = select.value;
			render();
		});
		const label = el('label', 'dim', `${dim} `);
		label.append(select);
		bar.append(label);
	}
	const button = (text, action) => {
		const b = el('button', '', text);
		b.addEventListener('click', action);
		bar.append(b);
	};
	button('New call', () => {
		sel.path = [];
		render();
		scrollTo({ left: 0, top: 0, behavior: 'smooth' });
	});
	button('Save .html', saveHtml);
	button('Save .md', () => download(`${document.title}.md`, md, 'text/markdown'));
	canvas.style.marginTop = `${bar.offsetHeight}px`;
}

function errorList(errors, fmt) {
	const ul = el('ul', 'errors');
	for (const e of errors) {
		const li = el('li');
		li.textContent = fmt(e);
		ul.append(li);
	}
	return ul;
}

function click(n) {
	if (editing) return;
	const now = performance.now();
	clearTimeout(revealing);
	if (lastClick.id === n.id && now - lastClick.t < DOUBLE_CLICK_MS) {
		lastClick = { id: null, t: 0 };
		edit(n);
		return;
	}
	lastClick = { id: n.id, t: now };
	go(n.id);
	revealing = setTimeout(() => reveal(n.id), DOUBLE_CLICK_MS); // scrolling earlier would move the card from under a second click
}

function go(id, from) {
	if (from !== undefined && sel.path.at(-1) !== from) sel.path.push(from);
	if (sel.path.at(-1) !== id) sel.path.push(id);
	Object.assign(sel.variants, graph.nodes.find(n => n.id === id).tags);
	render();
}

function reveal(id) {
	const targets = graph.edges.filter(e => e.from === id && cards.has(e.to)).map(e => cards.get(e.to));
	const rects = [cards.get(id), ...targets].map(c => c.getBoundingClientRect());
	const pad = 24;
	const top = bar.offsetHeight + pad;
	const scrollFor = (lo, hi, min, max) => (hi > max ? Math.min(hi - max, lo - min) : lo < min ? lo - min : 0);
	scrollBy({
		left: scrollFor(Math.min(...rects.map(r => r.left)), Math.max(...rects.map(r => r.right)), pad, innerWidth - pad),
		top: scrollFor(Math.min(...rects.map(r => r.top)), Math.max(...rects.map(r => r.bottom)), top, innerHeight - pad),
		behavior: 'smooth',
	});
}

function edit(n) {
	editing = n.id;
	const card = cards.get(n.id);
	const ta = el('textarea');
	ta.value = md.slice(n.start, n.end).trimEnd();
	ta.spellcheck = false;
	const errors = el('div');
	card.classList.add('editing');
	card.replaceChildren(ta, errors);
	const fit = () => {
		ta.style.height = 'auto';
		ta.style.height = `${ta.scrollHeight + 2}px`;
	};
	ta.addEventListener('input', fit);
	ta.addEventListener('click', e => e.stopPropagation());
	ta.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			editing = null;
			render();
		} else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			const text = ta.value.trimEnd();
			const next = md.slice(0, n.start) + (text && text + (n.end < md.length ? '\n\n' : '\n')) + md.slice(n.end);
			const base = md.slice(0, n.start).split('\n').length - 1;
			const lines = text.split('\n').length;
			const g = SCRIPT_TAG.test(next) ? { errors: [{ line: 0, msg: 'a <script> tag cannot be embedded' }] } : parse(next);
			if (g.errors.length) {
				errors.replaceChildren(errorList(g.errors, e => (e.line > base && e.line <= base + lines ? `line ${e.line - base}: ${e.msg}` : e.line ? `elsewhere, document line ${e.line}: ${e.msg}` : e.msg)));
				return;
			}
			md = next;
			graph = g;
			dirty = true;
			editing = null;
			render();
		}
	});
	fit();
	ta.focus();
}

function download(name, text, type) {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type }));
	a.download = name;
	a.click();
}

function saveHtml() {
	if (SCRIPT_TAG.test(md)) throw new Error('markdown contains a <script> tag; commit should have rejected it');
	const doc = new DOMParser().parseFromString(pristine, 'text/html');
	doc.getElementById('src').textContent = md;
	download(`${document.title}.html`, `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, 'text/html');
	dirty = false;
	renderBar();
}

document.addEventListener('keydown', e => {
	if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		saveHtml();
	}
});
addEventListener('beforeunload', e => dirty && e.preventDefault());

render();
