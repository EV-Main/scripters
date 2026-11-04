const KEY = `scripters:${document.title}`;
const RANKDIR = document.documentElement.dataset.rankdir;
if (!['LR', 'TB'].includes(RANKDIR)) throw new Error(`bundler wrote an unknown rankdir: ${RANKDIR}`);
const DOUBLE_CLICK_MS = 400;
const SCRIPT_TAG = /<\/?script/i; // would end or nest the embedding <script> block
const SPACING_KEY = 'scripters:spacing'; // shared across scripts: a viewing preference, not part of a call
const THEME_KEY = 'scripters:theme';
const ZOOM_KEY = 'scripters:zoom';
const ZOOM_STEP = 1.2;
const [MIN_ZOOM, MAX_ZOOM] = [0.2, 3];
const LABEL_NAME = /^[\w-]+$/;
const COLOR = /^oklch\((\d*\.?\d+) \d*\.?\d+ \d*\.?\d+\)$/; // canonical form; model.js parses the same
const SWATCHES = [25, 55, 85, 130, 165, 200, 240, 275, 310, 345].flatMap(h => [`oklch(0.62 0.19 ${h})`, `oklch(0.86 0.09 ${h})`]);
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const ARROW_SPEED = 1200; // px/s, about native arrow-repeat speed
const GITHUB_MARK = '<svg viewBox="0 0 16 16" fill="currentColor" aria-label="GitHub"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';
const randomColor = () => `oklch(${(0.5 + Math.random() * 0.4).toFixed(2)} 0.15 ${Math.floor(Math.random() * 360)})`;
const pristine = document.documentElement.outerHTML;
const bar = document.getElementById('bar');
const canvas = document.getElementById('canvas');

let md = document.getElementById('src').textContent;
let graph = parse(md);
const setting = name => graph.marks.find(m => m.setting === name)?.value;
let sel = JSON.parse(sessionStorage.getItem(KEY)) ?? {
	variants: Object.fromEntries(graph.marks.filter(m => m.dim !== null).map(m => [m.dim, m.value])),
	lang: setting('lang'),
	path: [],
	calling: false,
};
sel.layout ??= document.documentElement.dataset.layout ?? setting('layout') ?? 'dfs'; // `--layout` outranks the md's mark; absent from a selection stored before layouts
let saved = md; // what the file on disk holds
let undos = []; // earlier mds, latest last; in memory only
let redos = [];
let live = document.documentElement.dataset.live; // version of the md a `watch` server built this page from; absent in a built file
let editing = null;
let lastClick = { id: null, t: 0 };
let cards = new Map();
let held = new Set(); // arrow keys down; scrolled per frame instead of by OS key repeat, which stutters
let lastFrame = 0;
let shortcuts = new Map(); // key → bar control it clicks; rebuilt with the bar
let spacing = Number(localStorage.getItem(SPACING_KEY) ?? 1);
if (!(spacing > 0)) throw new Error(`corrupt stored spacing: ${localStorage.getItem(SPACING_KEY)}`);
let theme = localStorage.getItem(THEME_KEY) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
if (!['light', 'dark'].includes(theme)) throw new Error(`corrupt stored theme: ${theme}`);
document.documentElement.dataset.theme = theme;
let zoom = Number(localStorage.getItem(ZOOM_KEY) ?? 1);
if (!(zoom >= MIN_ZOOM && zoom <= MAX_ZOOM)) throw new Error(`corrupt stored zoom: ${localStorage.getItem(ZOOM_KEY)}`);
canvas.style.zoom = zoom;
canvas.style.setProperty('--zoom', zoom);
let pinch = null; // the two-finger touch's start: {spread, zoom, at}
let gestureZoom = null; // Safari's touchpad pinch reports scale relative to its start
let labelForm = null; // {orig: name being edited, or null for a new label; name, description, color}
const labelsDialog = el('dialog', 'labels');
document.body.append(labelsDialog);

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
	if (!graph.langs.includes(sel.lang)) sel.lang = graph.langs[0]; // the document's first language; none when it has no `<div lang>`
	sessionStorage.setItem(KEY, JSON.stringify(sel));

	renderBar();
	if (labelsDialog.open) renderLabels();
	const at = [scrollX, scrollY]; // emptying the canvas drops its overscroll, and the browser clamps the scroll to that
	canvas.replaceChildren();
	cards = new Map();
	if (graph.errors.length) {
		canvas.append(errorList(graph.errors, e => `line ${e.line}: ${e.msg}`));
		canvas.style.width = canvas.style.height = '';
		return;
	}

	const shown = visible(graph, sel);
	const nodes = graph.nodes.filter(n => shown.has(n.id));
	const edges = graph.edges.filter(e => shown.has(e.from) && shown.has(e.to) && inScope(e, sel));
	const current = sel.path.at(-1);
	const walked = new Set(sel.path.slice(1).map((id, i) => `${sel.path[i]}\n${id}`));
	const exits = new Set(edges.map(e => e.from));
	const hue = e => (graph.nodes.findIndex(n => n.id === e.to) * 110) % 360; // by target node: 36 hues before repeating, 110° apart so consecutive nodes differ
	const pending = scope => Object.entries(scope).filter(([k]) => k !== 'lang' && !(k in sel.variants)); // its variants not chosen yet
	const chips = vs => vs.map(([k, v]) => el('span', 'chip', `${k}=${v}`));

	for (const n of nodes) {
		const card = el('article', 'card');
		card.dataset.id = n.id;
		card.classList.toggle('visited', sel.path.includes(n.id));
		card.classList.toggle('current', n.id === current);
		card.classList.toggle('terminal', !exits.has(n.id));
		const head = el('header');
		head.append(...chips(pending(n.scope)));
		for (const name of n.labels) {
			const p = pill(graph.labels.find(l => l.name === name));
			const x = el('button', 'unlabel', '×');
			x.title = `remove ${name}`;
			x.addEventListener('click', e => {
				e.stopPropagation();
				assert(!commit(splice([attrs(n, n.labels.filter(l => l !== name))])), 'removing a label broke the document');
			});
			p.append(x);
			head.append(p);
		}
		head.append(labelPicker(n));
		head.append(el('h2', '', marked.parseInline(n.titles[sel.lang] ?? n.title)));
		const del = el('button', 'delete', '×');
		del.title = 'delete card (select, then Backspace)';
		del.addEventListener('click', e => {
			e.stopPropagation();
			remove(n);
		});
		const stick = el('button', 'connect');
		stick.title = 'drag onto another card to add a response to it';
		stick.addEventListener('click', e => e.stopPropagation());
		stick.addEventListener('pointerdown', e => drag(e, n));
		const body = el('div', 'body');
		const runs = []; // consecutive lines pending the same variants
		for (const l of n.body.filter(l => inScope(l, sel))) {
			const vs = pending(l.scope);
			if (JSON.stringify(runs.at(-1)?.vs) !== JSON.stringify(vs)) runs.push({ vs, lines: [] });
			runs.at(-1).lines.push(l.text);
		}
		for (const { vs, lines } of runs.filter(r => r.lines.some(l => l.trim() !== ''))) { // a variant holding only responses frames nothing
			const html = el('template', '', marked.parse(lines.join('\n'))).content;
			if (!vs.length) {
				body.append(html);
				continue;
			}
			const variant = el('section', 'variant');
			variant.title = 'choose this variant';
			variant.append(...chips(vs), html);
			variant.addEventListener('click', () => Object.assign(sel.variants, Object.fromEntries(vs))); // before the card's own click renders
			body.append(variant);
		}
		card.append(del, stick, head, body);
		card.addEventListener('click', () => {
			if (!editing) Object.assign(sel.variants, Object.fromEntries(pending(n.scope)));
			click(n);
		});
		canvas.append(card);
		cards.set(n.id, card);
	}
	const labels = edges.map(e => {
		if (e.label.trim() === '') return null; // walked by clicking the card it leads to
		const label = el('button', 'label', marked.parseInline(e.label));
		label.prepend(...chips(pending(e.scope)));
		label.classList.toggle('visited', walked.has(`${e.from}\n${e.to}`));
		label.style.setProperty('--hue', hue(e));
		label.addEventListener('click', () => {
			if (editing) return;
			Object.assign(sel.variants, Object.fromEntries(pending(e.scope)));
			go(e.to, e.from);
			if (sel.calling) reveal(e.to);
		});
		canvas.append(label);
		return label;
	});

	const laid = layout(
		sel.layout,
		RANKDIR,
		spacing,
		nodes.map(n => ({ id: n.id, width: cards.get(n.id).offsetWidth, height: cards.get(n.id).offsetHeight })),
		edges.map((e, i) => ({ from: e.from, to: e.to, width: labels[i]?.offsetWidth ?? 0, height: labels[i]?.offsetHeight ?? 0 })),
	);
	const [cross, crossSize] = RANKDIR === 'TB' ? ['x', 'width'] : ['y', 'height'];

	for (const n of nodes) {
		const { x, y, width, height } = laid.nodes.get(n.id);
		Object.assign(cards.get(n.id).style, { left: `${x - width / 2}px`, top: `${y - height / 2}px` });
	}
	const { width, height } = laid;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('width', width);
	svg.setAttribute('height', height);
	svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>';
	edges.forEach((e, i) => {
		const { points, x, y } = laid.routes[i];
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
		path.style.setProperty('--hue', hue(e));
		svg.append(path);
		if (labels[i]) Object.assign(labels[i].style, { left: `${x - labels[i].offsetWidth / 2}px`, top: `${y - labels[i].offsetHeight / 2}px` });
	});
	canvas.prepend(svg);
	Object.assign(canvas.style, { width: `${width}px`, height: `${height}px` });
	const top = Math.min(...[...laid.nodes.values()].map(p => p.rank));
	const first = [...laid.nodes.values()].filter(p => p.rank === top);
	const mid = (Math.min(...first.map(p => p[cross] - p[crossSize] / 2)) + Math.max(...first.map(p => p[cross] + p[crossSize] / 2))) / 2;
	canvas.style.setProperty('--head-left', `${mid}px`);
	canvas.style.setProperty('--head-right', `${laid[crossSize] - mid}px`);
	scrollTo(...at);
}

function renderBar() {
	bar.replaceChildren(el('strong', 'title', document.title));
	if (md !== saved) bar.append(el('span', 'dirty', '● unsaved'));
	if (graph.warnings.length) {
		const warnings = el('span', 'warnings', `⚠ ${graph.warnings.length} warning${graph.warnings.length > 1 ? 's' : ''}`);
		warnings.title = graph.warnings.map(w => `line ${w.line}: ${w.msg}`).join('\n');
		bar.append(warnings);
	}
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
	if (graph.langs.length) {
		const select = el('select');
		for (const l of graph.langs) select.append(new Option(l, l, false, sel.lang === l));
		select.addEventListener('change', () => {
			sel.lang = select.value;
			render();
		});
		const label = el('label', 'dim', 'language ');
		label.append(select);
		bar.append(label);
	}
	const layoutSelect = el('select');
	for (const l of LAYOUTS) layoutSelect.append(new Option(l, l, false, sel.layout === l));
	layoutSelect.addEventListener('change', () => {
		sel.layout = layoutSelect.value;
		render();
	});
	const layoutLabel = el('label', 'dim', 'layout ');
	layoutLabel.title = 'which response of a loop points back up: dfs ranks a card below its latest caller, bfs below its earliest';
	layoutLabel.append(layoutSelect);
	bar.append(layoutLabel);
	const range = el('input');
	Object.assign(range, { type: 'range', min: 0.1, max: 3, step: 0.1, value: spacing });
	range.addEventListener('change', () => { // not `input`: render() rebuilds the bar, which would drop the slider mid-drag
		spacing = Number(range.value);
		localStorage.setItem(SPACING_KEY, spacing);
		render();
	});
	const spacingLabel = el('label', 'dim', 'spacing ');
	spacingLabel.append(range);
	bar.append(spacingLabel);
	shortcuts = new Map();
	const control = (c, hint, keys) => {
		c.title = [hint, ...keys.map(k => `[${k}]`)].join('\n');
		for (const k of keys) {
			assert(!shortcuts.has(k), `two bar controls bound to ${k}`);
			shortcuts.set(k, c);
		}
		return c;
	};
	const button = (text, hint, keys, action, parent = bar) => {
		const b = control(el('button', '', text), hint, keys);
		b.addEventListener('click', action);
		parent.append(b);
		return b;
	};
	const center = () => [innerWidth / 2, (bar.offsetHeight + innerHeight) / 2];
	button('−', 'zoom out; pinch or Ctrl+scroll zoom too', ['-', '_'], () => zoomTo(zoom / ZOOM_STEP, ...center()));
	button('+', 'zoom in', ['+', '='], () => zoomTo(zoom * ZOOM_STEP, ...center()));
	button('↶', 'undo an edit; Ctrl+Z too', ['u'], () => travel(undos, redos)).disabled = !undos.length;
	button('↷', 'redo; Ctrl+Y, Ctrl+Shift+Z too', ['U'], () => travel(redos, undos)).disabled = !redos.length;
	const add = button('⊞', 'new card', ['N'], create);
	add.classList.add('push');
	add.disabled = graph.errors.length > 0;
	button('Labels', 'define the labels cards carry', ['l'], () => {
		renderLabels();
		labelsDialog.showModal();
	});
	button('New call', 'clear the walked path; the view follows the call until Clear; `c` scrolls to the start first', ['c'], newCall).classList.toggle('on', sel.calling);
	button('Clear', 'clear the walked path and end the call', ['Escape'], () => {
		sel.path = [];
		sel.calling = false;
		render();
	});
	const menu = el('details', 'menu');
	menu.append(control(el('summary', '', 'Export'), `download a copy; Ctrl+S ${live ? 'writes the md' : 'overwrites the opened file'}`, ['e']));
	const items = el('div', 'items');
	button('.html', 'this page, with the current script', [], () => download(`${document.title}.csr.html`, html(stamped()), 'text/html'), items);
	button('.md', 'the script alone', [], () => download(`${document.title}.scr.md`, stamped(), 'text/markdown'), items);
	menu.append(items);
	bar.append(menu);
	button(theme === 'dark' ? '☀' : '☾', 'theme', [], () => {
		theme = theme === 'dark' ? 'light' : 'dark';
		localStorage.setItem(THEME_KEY, theme);
		document.documentElement.dataset.theme = theme;
		renderBar();
	});
	const repo = el('a', 'repo', GITHUB_MARK);
	Object.assign(repo, { href: document.documentElement.dataset.repo, target: '_blank', rel: 'noopener', title: 'source on GitHub' });
	bar.append(repo);
	document.body.style.paddingTop = `${bar.offsetHeight}px`; // a canvas margin would be zoomed
}

function newCall() {
	sel.path = [];
	sel.calling = true;
	render();
	toStart();
}

// whether the view moved
function toStart() {
	const at = [scrollX, scrollY];
	scrollTo(canvas.getBoundingClientRect().left + scrollX, 0);
	return scrollX !== at[0] || scrollY !== at[1];
}

function glide(t) {
	if (!held.size) return;
	const step = (ARROW_SPEED * Math.max(0, t - lastFrame)) / 1000; // the frame timestamp can predate the keydown that started us
	lastFrame = t;
	const [dx, dy] = [...held].reduce(([x, y], k) => [x + ARROWS[k][0], y + ARROWS[k][1]], [0, 0]);
	scrollBy(dx * step, dy * step);
	requestAnimationFrame(glide);
}

// the canvas point under the client point (cx, cy)
function canvasAt(cx, cy) {
	const r = canvas.getBoundingClientRect();
	return [(cx - r.left) / zoom, (cy - r.top) / zoom];
}

function zoomTo(z, cx, cy, at = canvasAt(cx, cy)) {
	zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
	localStorage.setItem(ZOOM_KEY, zoom);
	canvas.style.zoom = zoom;
	canvas.style.setProperty('--zoom', zoom);
	const r = canvas.getBoundingClientRect();
	scrollBy(r.left + at[0] * zoom - cx, r.top + at[1] * zoom - cy);
}

function pill(label) {
	const p = el('span', 'pill');
	p.textContent = label.name;
	p.title = label.description;
	p.style.background = label.color;
	p.style.color = Number(COLOR.exec(label.color)[1]) > 0.7 ? 'oklch(0.2 0 0)' : 'oklch(1 0 0)';
	return p;
}

function labelPicker(n) {
	const pick = el('select', 'add');
	pick.title = 'add a label';
	pick.append(new Option('+', '', true, true));
	pick.options[0].hidden = true;
	for (const l of graph.labels) if (!n.labels.includes(l.name)) pick.append(new Option(l.name, l.name));
	pick.append(new Option('Edit labels…', ' edit'));
	pick.addEventListener('click', e => e.stopPropagation());
	pick.addEventListener('change', () => {
		if (pick.value === ' edit') {
			renderLabels();
			labelsDialog.showModal();
			pick.value = '';
		} else assert(!commit(splice([attrs(n, [...n.labels, pick.value])])), 'adding a defined label broke the document');
	});
	return pick;
}

function renderLabels() {
	const head = el('header');
	head.append(el('h2', '', `${graph.labels.length} labels`));
	const add = el('button', 'primary', 'New label');
	add.addEventListener('click', () => {
		labelForm = { orig: null, name: '', description: '', color: randomColor() };
		renderLabels();
	});
	const close = el('button', '', 'Close');
	close.addEventListener('click', () => labelsDialog.close());
	head.append(add, close);
	labelsDialog.replaceChildren(head);
	if (labelForm && labelForm.orig === null) labelsDialog.append(labelEditor());
	const list = el('ul');
	for (const l of graph.labels) {
		if (labelForm?.orig === l.name) {
			list.append(labelEditor());
			continue;
		}
		const row = el('li');
		const uses = graph.nodes.filter(n => n.labels.includes(l.name)).length;
		const description = el('span', 'description');
		description.textContent = l.description;
		row.append(pill(l), description, el('span', 'uses', uses ? `${uses} card${uses > 1 ? 's' : ''}` : ''));
		const edit = el('button', 'link', 'Edit');
		edit.addEventListener('click', () => {
			labelForm = { orig: l.name, name: l.name, description: l.description, color: l.color };
			renderLabels();
		});
		const del = el('button', 'link danger', 'Delete');
		del.addEventListener('click', () => {
			if (!confirm(`Delete label "${l.name}"?${uses ? ` It is removed from ${uses} card${uses > 1 ? 's' : ''}.` : ''}`)) return;
			assert(!commit(splice([{ start: l.start, end: l.end, text: '' }, ...relabel(l.name, null)])), 'deleting a label broke the document');
		});
		row.append(edit, del);
		list.append(row);
	}
	labelsDialog.append(list);
}

// `name: null` drops the label
function relabel(from, name) {
	return graph.nodes.filter(n => n.labels.includes(from)).map(n => attrs(n, n.labels.flatMap(l => (l !== from ? [l] : name === null ? [] : [name]))));
}

function labelEditor() {
	const f = labelForm;
	const form = el('form', 'editor');
	const preview = el('div', 'preview');
	const errors = el('div');
	const showPreview = () => preview.replaceChildren(pill({ name: f.name || 'Label preview', description: f.description, color: COLOR.test(f.color) ? f.color : 'oklch(0.93 0 0)' }));
	const field = (label, input) => {
		const l = el('label', '', label);
		l.append(input);
		form.append(l);
	};
	const text = (key, attrsOf) => {
		const i = Object.assign(el('input'), { value: f[key], ...attrsOf });
		i.addEventListener('input', () => {
			f[key] = i.value;
			showPreview();
		});
		return i;
	};
	form.append(preview);
	field('Label name', text('name', { required: true, pattern: LABEL_NAME.source.slice(1, -1), title: 'letters, digits, _ and -' }));
	field('Description', text('description', { placeholder: 'Description (optional)' }));
	const color = el('div', 'color');
	const random = el('button', '', '⟳');
	Object.assign(random, { type: 'button', title: 'random color' });
	const value = text('color', { required: true, pattern: COLOR.source.slice(1, -1), title: 'oklch(L C H)', size: 20 });
	const set = c => {
		f.color = value.value = c;
		showPreview();
	};
	random.addEventListener('click', () => set(randomColor()));
	const swatches = el('div', 'swatches');
	for (const c of SWATCHES) {
		const b = el('button');
		Object.assign(b, { type: 'button', title: c });
		b.style.background = c;
		b.addEventListener('click', () => set(c));
		swatches.append(b);
	}
	color.append(random, value);
	field('Color', color);
	form.append(swatches);
	const cancel = el('button', '', 'Cancel');
	cancel.type = 'button';
	cancel.addEventListener('click', () => {
		labelForm = null;
		renderLabels();
	});
	form.append(cancel, el('button', 'primary', f.orig === null ? 'Create label' : 'Save changes'), errors);
	form.addEventListener('submit', e => {
		e.preventDefault();
		const line = `[${f.name}]: <${f.color}>${f.description && ` "${f.description.replace(/[\\"]/g, '\\$&')}"`}\n`;
		const def = graph.labels.find(l => l.name === f.orig);
		const last = graph.labels.at(-1);
		const edits = def ? [{ start: def.start, end: def.end, text: line }, ...(f.name !== f.orig ? relabel(f.orig, f.name) : [])] : [last ? { start: last.end, end: last.end, text: line } : { start: 0, end: 0, text: `${line}\n` }];
		labelForm = null;
		const failed = commit(splice(edits));
		if (failed) {
			labelForm = f;
			errors.replaceChildren(errorList(failed, e => e.msg));
		}
	});
	showPreview();
	return form;
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
	if (lastClick.id === n.id && now - lastClick.t < DOUBLE_CLICK_MS) {
		lastClick = { id: null, t: 0 };
		edit(n);
		return;
	}
	lastClick = { id: n.id, t: now };
	go(n.id);
	if (sel.calling) reveal(n.id);
}

function go(id, from) {
	if (from !== undefined && sel.path.at(-1) !== from) sel.path.push(from);
	if (sel.path.at(-1) !== id) sel.path.push(id);
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
	});
}

// edits: [{start, end, text}] against the current md
// r[impl page.md-truth]
function splice(edits) {
	edits.sort((a, b) => b.start - a.start);
	edits.forEach((e, i) => i && assert(e.end <= edits[i - 1].start, 'splice edits overlap'));
	return edits.reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), md);
}

// the errors of `next`, or null once it replaced the md
function commit(next) {
	const g = SCRIPT_TAG.test(next) ? { errors: [{ line: 0, msg: 'a <script> tag cannot be embedded' }] } : parse(next);
	if (g.errors.length) return g.errors;
	adopt(next, g);
	return null;
}

function adopt(next, g) {
	if (next !== md) {
		undos.push(md);
		redos = [];
	}
	md = next;
	graph = g;
	render();
}

// the md on disk changed: unsaved edits merge into it, or on a clash wait in undo
function sync(disk, version) {
	const merged = md === saved ? disk : merge(saved, md, disk);
	const g = merged !== null && parse(merged);
	const clash = md !== saved && (!g || g.errors.length > 0);
	live = version;
	saved = disk;
	if (clash) toast('The md changed on disk where this page has unsaved edits: showing the disk\'s, u brings the edits back', 8);
	adopt(clash ? disk : merged, clash ? parse(disk) : g);
}

function toast(text, seconds) {
	document.querySelector('.toast')?.remove();
	const t = el('output', 'toast');
	t.textContent = text;
	t.style.animationDuration = `${seconds}s`;
	t.addEventListener('animationend', () => t.remove());
	document.body.append(t);
}

function travel(from, to) {
	to.push(md);
	md = from.pop();
	graph = parse(md); // a broken md from disk can be in history
	editing = null;
	render();
}

// the heading's `{…}` block rewritten to carry `labels`
function attrs(n, labels) {
	return { start: n.attrs.start, end: n.attrs.end, text: labels.length ? ` {${labels.map(l => `.${l}`).join(' ')}}` : '' };
}

function remove(n) {
	const inside = e => e.start >= n.start && e.end <= n.end;
	const responses = graph.edges.filter(e => e.to === n.id && !inside(e));
	if (!confirm(`Delete "${n.title}"?${responses.length ? ` ${responses.length} response${responses.length > 1 ? 's' : ''} leading to it go too.` : ''}`)) return;
	const errors = commit(splice([{ start: n.start, end: n.end, text: '' }, ...responses.map(e => ({ start: e.start, end: e.end, text: '' }))]));
	if (errors) alert(`Cannot delete "${n.title}":\n${errors.map(e => e.msg).join('\n')}`);
}

function drag(down, n) {
	if (editing) return;
	down.preventDefault();
	down.stopPropagation();
	const stick = down.currentTarget;
	stick.setPointerCapture(down.pointerId);
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.classList.add('draft');
	path.setAttribute('marker-end', 'url(#arrow)');
	canvas.querySelector(':scope > svg').append(path);
	const [x0, y0] = canvasAt(down.clientX, down.clientY);
	let target = null;
	const done = new AbortController();
	stick.addEventListener('pointermove', e => {
		const [x, y] = canvasAt(e.clientX, e.clientY);
		path.setAttribute('d', `M${x0},${y0} L${x},${y}`);
		const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card'); // null past the viewport's edge
		target?.classList.remove('target');
		target = over && over !== cards.get(n.id) ? over : null;
		target?.classList.add('target');
	}, { signal: done.signal });
	const finish = drop => () => {
		done.abort();
		path.remove();
		target?.classList.remove('target');
		if (drop && target) connect(n, target.dataset.id);
	};
	stick.addEventListener('pointerup', finish(true), { signal: done.signal });
	stick.addEventListener('pointercancel', finish(false), { signal: done.signal });
}

// the new response goes after `n`'s last one, or ends its section
function connect(n, slot) {
	const response = `- [TODO](#${slot})`;
	const exits = graph.edges.filter(e => e.from === n.id && !Object.keys(e.scope).length); // after a scoped one it would land inside its `<div>`
	const at = exits.length ? Math.max(...exits.map(e => e.end)) : n.start + md.slice(n.start, n.end).trimEnd().length;
	const text = !exits.length ? `\n\n${response}` : md[at - 1] === '\n' ? `${response}\n` : `\n${response}`;
	const errors = commit(splice([{ start: at, end: at, text }]));
	if (errors) alert(`Cannot link "${n.title}" to #${slot}:\n${errors.map(e => e.msg).join('\n')}`);
}

function create() {
	let i = 1;
	while (graph.nodes.some(n => n.id === `new-card${i > 1 ? `-${i}` : ''}`)) i++; // the slot of the title below
	const title = `New card${i > 1 ? ` ${i}` : ''}`;
	const failed = commit(splice([{ start: md.length, end: md.length, text: `${md.endsWith('\n') ? '' : '\n'}\n# ${title}\n` }]));
	assert(!failed, `appending "${title}" broke the document: ${failed?.map(e => e.msg).join('; ')}`);
	const n = graph.nodes.find(n => n.title === title);
	edit(n);
	cards.get(n.id).querySelector('textarea').setSelectionRange(2, 2 + title.length);
	reveal(n.id);
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
		if (['Enter', 's'].includes(e.key) && (e.ctrlKey || e.metaKey)) { // Ctrl+S goes on to save
			e.preventDefault();
			const text = ta.value.trimEnd();
			const base = md.slice(0, n.start).split('\n').length - 1;
			const lines = text.split('\n').length;
			editing = null;
			const failed = commit(splice([{ start: n.start, end: n.end, text: text && text + (n.end < md.length ? '\n\n' : '\n') }]));
			if (failed) {
				e.stopPropagation();
				editing = n.id;
				errors.replaceChildren(errorList(failed, e => (e.line > base && e.line <= base + lines ? `line ${e.line - base}: ${e.msg}` : e.line ? `elsewhere, document line ${e.line}: ${e.msg}` : e.msg)));
			}
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

// the md as saved: its selection marks follow the selection, and a `---` ends a nonempty preamble
function stamped() {
	if (graph.errors.length) return md; // nothing to stamp against; the broken md saves as it is
	const key = m => m.dim ?? `"${m.setting}"`; // a dim is `[\w-]+`, so never quoted
	const want = new Map([...Object.keys(graph.dims).filter(k => k in sel.variants).map(k => [k, sel.variants[k]]), ...(sel.lang ? [['"lang"', sel.lang]] : []), ['"layout"', sel.layout]]);
	const line = (k, value) => (k.startsWith('"') ? `[${k.slice(1, -1)}="${value}"]: #\n` : `[${k}=${value}]: #\n`);
	const edits = graph.marks.flatMap(m => {
		const value = want.get(key(m));
		want.delete(key(m));
		return value === m.value ? [] : [{ start: m.start, end: m.end, text: value === undefined ? '' : line(key(m), value) }];
	});
	const at = graph.marks.at(-1)?.end ?? graph.labels.at(-1)?.end ?? 0;
	edits.push({ start: at, end: at, text: [...want].map(([k, v]) => line(k, v)).join('') });
	const next = splice(edits);
	const g = parse(next);
	assert(!g.errors.length, `stamping broke the document: ${g.errors.map(e => e.msg).join('; ')}`);
	const { end, ruled } = g.preamble;
	return next.slice(0, end).trim() === '' || ruled ? next : `${next.slice(0, end).trimEnd()}\n\n---\n\n${next.slice(end)}`;
}

function html(text) {
	assert(!SCRIPT_TAG.test(text), 'markdown contains a <script> tag; commit should have rejected it');
	const doc = new DOMParser().parseFromString(pristine, 'text/html');
	doc.getElementById('src').textContent = text;
	delete doc.documentElement.dataset.live; // a downloaded copy is not served
	delete doc.documentElement.dataset.layout; // `text` carries the layout's mark
	return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

// a page on file:// cannot learn its own file handle: the user picks the file once, then it is remembered per url
async function overwrite() {
	const text = stamped();
	if (live) {
		const r = await fetch('/', { method: 'PUT', headers: { 'If-Match': live }, body: text });
		if (!r.ok) {
			alert(await r.text());
			return;
		}
		live = await r.text();
		wrote(text);
		toast('Saved', 1.5);
		return;
	}
	if (!window.showSaveFilePicker) {
		alert('This browser cannot overwrite files; download a copy with Export instead.');
		return;
	}
	let handle = await handles('readonly', s => s.get(location.href));
	if (handle && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') handle = undefined;
	if (!handle) {
		try {
			handle = await showSaveFilePicker({ suggestedName: decodeURIComponent(location.pathname.split('/').at(-1)), types: [{ description: 'html', accept: { 'text/html': ['.html'] } }] });
		} catch (e) {
			if (e.name === 'AbortError') return; // the user closed the picker
			throw e;
		}
		await handles('readwrite', s => s.put(handle, location.href));
	}
	const w = await handle.createWritable();
	await w.write(html(text));
	await w.close();
	wrote(text);
}

// stamping adds no undo step: it changes no card. An open edit holds offsets into the md, so the md takes the stamp at a later save
function wrote(text) {
	saved = text;
	if (editing || text === md) return renderBar();
	md = text;
	graph = parse(md);
	render();
}

function handles(mode, op) {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open('scripters', 1);
		open.onupgradeneeded = () => open.result.createObjectStore('handles');
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const req = op(open.result.transaction('handles', mode).objectStore('handles'));
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		};
	});
}

document.addEventListener('keydown', e => {
	const typing = e.target.closest('input, textarea, select');
	const plain = !(e.ctrlKey || e.metaKey || e.altKey);
	if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		overwrite();
	} else if (labelsDialog.open) {
		return;
	} else if (e.key === 'Escape') { // document-level: the textarea loses focus on any click outside it
		if (editing) {
			editing = null;
			render();
		} else shortcuts.get('Escape').click();
	} else if ((e.ctrlKey || e.metaKey) && !e.altKey && !editing && !typing && ['z', 'y'].includes(e.key.toLowerCase())) { // in a text field these stay its own undo
		e.preventDefault();
		shortcuts.get(e.key === 'z' ? 'u' : 'U').click();
	} else if (editing || typing || !plain) {
		return;
	} else if (e.key in ARROWS) {
		e.preventDefault();
		if (!held.size) {
			lastFrame = performance.now();
			requestAnimationFrame(glide);
		}
		held.add(e.key);
	} else if (e.key === 'c' && toStart()) { // once at the start, `c` is New call
		return;
	} else if (shortcuts.has(e.key)) {
		e.preventDefault(); // `N` focuses a new card's editor, which would take the key's character
		shortcuts.get(e.key).click();
	} else if (e.key === 'Backspace' && cards.has(sel.path.at(-1))) {
		e.preventDefault();
		remove(graph.nodes.find(n => n.id === sel.path.at(-1)));
	}
});
document.addEventListener('keyup', e => held.delete(e.key));
addEventListener('blur', () => held.clear()); // keyup never arrives once focus leaves the page
document.addEventListener('click', e => {
	for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
});
addEventListener(
	'wheel',
	e => {
		if (!e.ctrlKey) return; // touchpad pinches arrive as Ctrl+wheel in Chromium and Firefox
		e.preventDefault();
		zoomTo(zoom * Math.exp(-(e.deltaMode ? 16 : 1) * e.deltaY * 0.01), e.clientX, e.clientY);
	},
	{ passive: false },
);
addEventListener('gesturestart', e => {
	e.preventDefault();
	gestureZoom = zoom;
});
addEventListener('gesturechange', e => {
	e.preventDefault();
	if (!pinch) zoomTo(gestureZoom * e.scale, e.clientX, e.clientY); // on iOS the touch handlers below already pinch
});
const spread = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const middle = t => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
addEventListener('touchstart', e => {
	if (e.touches.length === 2) pinch = { spread: spread(e.touches), zoom, at: canvasAt(...middle(e.touches)) };
});
addEventListener(
	'touchmove',
	e => {
		if (!pinch || e.touches.length !== 2) return;
		e.preventDefault();
		zoomTo((pinch.zoom * spread(e.touches)) / pinch.spread, ...middle(e.touches), pinch.at);
	},
	{ passive: false },
);
for (const t of ['touchend', 'touchcancel']) addEventListener(t, e => e.touches.length < 2 && (pinch = null));
labelsDialog.addEventListener('close', () => (labelForm = null));
addEventListener('beforeunload', e => md !== saved && e.preventDefault());
if (live)
	(async function poll() {
		const asked = live; // a save meanwhile moves `live` past what this poll saw
		const current = () => live === asked && !editing; // an open edit holds offsets into the md
		try {
			if ((await (await fetch('/version')).text()) !== live && current()) {
				const page = new DOMParser().parseFromString(await (await fetch('/')).text(), 'text/html');
				if (current()) sync(page.getElementById('src').textContent, page.documentElement.dataset.live);
			}
		} catch (e) {
			if (e instanceof TypeError) return; // the watch stopped serving
			throw e;
		}
		setTimeout(poll, 300);
	})();

render();
if (performance.getEntriesByType('navigation')[0].type !== 'reload') toStart(); // a reload restores its scroll
