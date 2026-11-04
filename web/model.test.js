const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, visible, inScope } = require('./model.js');

const dedent = s => s.replace(/^\n/, '').replace(/^\t+/gm, '');

const scoped = (scope, text) => (Object.keys(scope).length ? `{${Object.entries(scope).map(([k, v]) => `${k}=${v}`).join(' ')}}${text}` : text);

function render(graph) {
	return [
		...graph.labels.map(l => `label ${l.name} ${l.color} ${JSON.stringify(l.description)}`),
		...graph.marks.map(m => (m.dim ? `mark ${m.dim}=${m.value}` : `mark ${m.setting}="${m.value}"`)),
		...graph.nodes.map(n => scoped(n.scope, `node ${n.id} "${n.title}"${n.stray ? ' stray' : ''}${n.labels.map(l => ` .${l}`).join('')}${Object.entries(n.titles).map(([l, t]) => ` ${l}="${t}"`).join('')} body=${JSON.stringify(n.body.map(l => scoped(l.scope, l.text)).join('\n').trim())}`)),
		...graph.edges.map(e => scoped(e.scope, `edge ${e.from} -[${e.label}]-> ${e.to}`)),
		...(graph.langs.length ? [`langs: ${graph.langs.join(' ')}`] : []),
		...Object.entries(graph.dims).map(([k, vs]) => `dim ${k}: ${vs.join(' ')}`),
		...graph.errors.map(e => `error L${e.line}: ${e.msg}`),
		...graph.warnings.map(e => `warning L${e.line}: ${e.msg}`),
	].join('\n');
}

function checkParse(md, expected) {
	assert.equal(render(parse(dedent(md))), dedent(expected).trim());
}

function checkVisible(md, selection, expected) {
	const graph = parse(dedent(md));
	assert.deepEqual(graph.errors, []);
	assert.deepEqual([...visible(graph, selection)].sort(), expected.sort());
}

test('slots and response edges', () => {
	checkParse(
		`
		# Hello, World!
		Say [hi](#opening) warmly.

		- [Has time](#opening)
		- not a [response](#opening) item

		# Opening
		`,
		`
		node hello-world "Hello, World!" body="Say [hi](#opening) warmly.\\n\\n- not a [response](#opening) item"
		node opening "Opening" body=""
		edge hello-world -[Has time]-> opening
		`,
	);
});

test('every heading level starts a node; seven `#` are body', () => {
	checkParse(
		`
		# A
		- [x](#b)
		## B
		- [y](#c)
		###### C ###
		####### not a heading
		`,
		`
		node a "A" body=""
		node b "B" body=""
		node c "C" body="####### not a heading"
		edge a -[x]-> b
		edge b -[y]-> c
		`,
	);
});

test('a heading starting with `-` ends the section and starts nothing', () => {
	checkParse(
		`
		# - Labels
		[l]: <oklch(0 0 0)>
		# A {.l}
		- [x](#b)
		<div lang="ru">
		## - not a title
		</div>
		# -Group
		## B
		# - Notes
		stray
		`,
		`
		label l oklch(0 0 0) ""
		node a "A" .l body=""
		node b "B" body=""
		edge a -[x]-> b
		langs: ru
		error L11: text outside any card
		`,
	);
});

test('an unlabeled response must be its card\'s only one', () => {
	checkParse(
		`
		# A
		- [](#b)
		# B
		- [x](#c)
		- [](#c)
		# C
		`,
		`
		node a "A" body=""
		node b "B" body=""
		node c "C" body=""
		edge a -[]-> b
		edge b -[x]-> c
		edge b -[]-> c
		error L5: an unlabeled response must be its card's only one
		`,
	);
	checkParse(
		`
		# A
		<div k="v">
		- [](#b)
		</div>
		<div k="w">
		- [x](#b)
		</div>
		# B
		`,
		`
		node a "A" body=""
		node b "B" body=""
		{k=v}edge a -[]-> b
		{k=w}edge a -[x]-> b
		dim k: v w
		`,
	);
});

test('a heading takes no variant tags', () => {
	checkParse('# A {k=v}\n', 'node a "A" body=""\nerror L1: `k=v` on a heading: variants are `<div k="v">` scopes');
});

test('headings and responses inside code fences are body', () => {
	checkParse(
		'# A\n```md\n# Not a node\n- [x](#nowhere)\n```\n~~~\n```\n# still fenced\n~~~\n',
		'node a "A" body="```md\\n# Not a node\\n- [x](#nowhere)\\n```\\n~~~\\n```\\n# still fenced\\n~~~"',
	);
});

test('parse errors', () => {
	checkParse(
		`
		intro text

		# A
		`,
		`
		node a "A" body=""
		error L1: text outside any card
		`,
	);
	checkParse(
		`
		# A
		- [x](#b)
		`,
		`
		node a "A" body=""
		error L2: response links to unknown slot #b
		`,
	);
	checkParse(
		`
		# A
		## A
		`,
		`
		node a "A" body=""
		node a "A" body=""
		error L2: duplicate of line 1: same slot
		`,
	);
	checkParse('', 'error L1: no headings');
});

test('labels are defined before the first heading and attached with `.name`', () => {
	checkParse(
		`
		[hot]: <oklch(0.6 0.2 25)> "Wants it \\"now\\""
		[later]: <oklch(0.55 0.15 145)>

		# A {.hot .later}
		- [x](#b)
		# B {.later}
		`,
		`
		label hot oklch(0.6 0.2 25) "Wants it \\"now\\""
		label later oklch(0.55 0.15 145) ""
		node a "A" .hot .later body=""
		node b "B" .later body=""
		edge a -[x]-> b
		`,
	);
	checkParse(
		`
		[hot]: <oklch(0.6 0.2 25)>
		[hot]: <oklch(0 0 0)>
		[cold]: #0000ff
		# A {.warm .hot .hot}
		`,
		`
		label hot oklch(0.6 0.2 25) ""
		node a "A" .warm .hot body=""
		error L2: label \`hot\` defined twice
		error L3: text outside any card
		error L4: label \`.hot\` given twice
		error L4: unknown label \`.warm\`
		`,
	);
});

test('selection marks and a `---` rule may precede the first heading', () => {
	checkParse(
		`
		[l]: <oklch(0 0 0)>
		[k=v]: #
		[lang="ru"]: #
		[layout="bfs"]: #

		---

		# A
		<div lang="ru">
		a
		</div>
		- [x](#b)
		# - Group
		---
		# B
		<div k="w">
		</div>
		<div k="v">
		</div>
		`,
		`
		label l oklch(0 0 0) ""
		mark k=v
		mark lang="ru"
		mark layout="bfs"
		node a "A" body="{lang=ru}a"
		node b "B" body=""
		edge a -[x]-> b
		langs: ru
		dim k: v w
		`,
	);
	checkParse(
		`
		[k=x]: #
		[k=v]: #
		[j=v]: #
		[lang="en"]: #
		[layout="dfs"]: #
		[layout="bfs"]: #
		[layout="flat"]: #
		# A
		<div k="v">
		</div>
		`,
		`
		mark k=x
		mark j=v
		mark lang="en"
		mark layout="dfs"
		node a "A" body=""
		dim k: v
		error L2: a second mark for \`k\`
		error L6: a second mark for \`layout\`
		error L7: a second mark for \`layout\`
		error L1: no \`<div k="x">\`
		error L3: no \`<div j="v">\`
		error L4: no \`<div lang="en">\`
		`,
	);
});

test('a layout mark names `dfs` or `bfs`', () => {
	checkParse('[layout="flat"]: #\n# A\n', 'mark layout="flat"\nnode a "A" body=""\nerror L1: no layout `flat`: `dfs` or `bfs`');
});

test('cards the first card cannot reach are warned of, and still shown', () => {
	const md = `
		# A
		# B
		- [x](#c)
		# C
		- [y](#b)
	`;
	checkParse(
		md,
		`
		node a "A" body=""
		node b "B" stray body=""
		node c "C" stray body=""
		edge b -[x]-> c
		edge c -[y]-> b
		warning L2: "B" is unreachable from the first card
		warning L4: "C" is unreachable from the first card
		`,
	);
	checkVisible(md, {}, ['a', 'b', 'c']);
});

test('the call starts at the first card even when a response leads back to it', () => {
	checkParse(
		`
		# A
		- [x](#b)
		# B
		- [back](#a)
		`,
		`
		node a "A" body=""
		node b "B" body=""
		edge a -[x]-> b
		edge b -[back]-> a
		`,
	);
});

test('spans locate the text an edit replaces', () => {
	const md = '[l]: <oklch(0 0 0)>\n\n# A {.l} ##\nbody\n- [x](#b)\n# B\n';
	const g = parse(md);
	assert.deepEqual(g.errors, []);
	const [a, b] = g.nodes;
	assert.equal(md.slice(a.attrs.start, a.attrs.end), ' {.l}');
	assert.equal(b.attrs.start, b.attrs.end);
	assert.equal(md.slice(0, b.attrs.start), '[l]: <oklch(0 0 0)>\n\n# A {.l} ##\nbody\n- [x](#b)\n# B');
	assert.equal(md.slice(g.edges[0].start, g.edges[0].end), '- [x](#b)\n');
	assert.equal(md.slice(g.labels[0].start, g.labels[0].end), '[l]: <oklch(0 0 0)>\n');
	assert.deepEqual(g.preamble, { end: md.indexOf('# A'), ruled: false });

	const marked = '[k=v]: #\n\n---\n\n# - G\n# A\n<div k="v">\n</div>\n';
	const m = parse(marked);
	assert.equal(marked.slice(m.marks[0].start, m.marks[0].end), '[k=v]: #\n');
	assert.deepEqual(m.preamble, { end: marked.indexOf('# - G'), ruled: true });
	assert.equal(parse('---\n[l]: <oklch(0 0 0)>\n# A\n').preamble.ruled, false);
});

test('`<div lang>` scopes body lines and responses to a language', () => {
	checkParse(
		`
		# A
		<div lang="ru">

		### А ## 
		Привет
		- [Да](#b)
		</div>
		<div lang="en">
		Hi
		- [Yes](#b)
		</div>

		> both
		- [Skip](#b)
		# B
		`,
		`
		node a "A" ru="А" body="{lang=ru}\\n{lang=ru}Привет\\n{lang=en}Hi\\n\\n> both"
		node b "B" body=""
		{lang=ru}edge a -[Да]-> b
		{lang=en}edge a -[Yes]-> b
		edge a -[Skip]-> b
		langs: ru en
		`,
	);
	checkParse(
		`
		# A
		<div lang="ru">
		<div lang="en">
		</div>
		</div>
		<div lang="de">
		# A1
		# A2 {.l}
		</div>
		<div lang="de">
		# A3
		</div>
		<div lang="fr">
		# B
		`,
		`
		node a "A" de="A1" fr="B" body=""
		langs: ru en de fr
		error L3: \`<div lang>\` inside another
		error L8: labels go on the main heading
		error L8: a second \`de\` title
		error L11: a second \`de\` title
		error L13: \`<div lang="fr">\` not closed
		`,
	);
});

test('a language hides the other languages\' responses and what only they reach', () => {
	const md = `
		# A
		<div lang="ru">
		- [Да](#b)
		</div>
		- [Skip](#c)
		# B
		# C
	`;
	checkVisible(md, {}, ['a', 'b', 'c']);
	checkVisible(md, { lang: 'en' }, ['a', 'c']);
	checkVisible(md, { lang: 'ru' }, ['a', 'b', 'c']);
	assert.equal(inScope({ scope: { lang: 'ru' } }, { lang: 'en' }), false);
});

test('variant scopes split one card and nest with language scopes either way', () => {
	checkParse(
		`
		# Opening
		Hi.
		<div opener="warm">
		Congrats on the new office.
		<div lang="ru">
		Поздравляю.
		- [Да](#pitch)
		</div>
		</div>
		<div lang="ru">

		## Начало
		<div opener="cold">
		Сколько звонков?
		</div>
		</div>
		<div opener="cold">
		How many calls?
		- [Gives a number](#pitch)
		</div>
		# Pitch
		`,
		`
		node opening "Opening" ru="Начало" body="Hi.\\n{opener=warm}Congrats on the new office.\\n{opener=warm lang=ru}Поздравляю.\\n{lang=ru}\\n{lang=ru opener=cold}Сколько звонков?\\n{opener=cold}How many calls?"
		node pitch "Pitch" body=""
		{opener=warm lang=ru}edge opening -[Да]-> pitch
		{opener=cold}edge opening -[Gives a number]-> pitch
		langs: ru
		dim opener: cold warm
		`,
	);
	checkParse(
		`
		# A
		<div k="v">
		<div k="w">
		</div>
		# A1
		<div lang="ru">
		# A2
		</div>
		</div>
		<div j="v">
		`,
		`
		node a "A" body=""
		langs: ru
		dim k: v w
		dim j: v
		error L3: \`<div k>\` inside another
		error L5: a heading inside a variant scope
		error L7: a heading inside a variant scope
		error L10: \`<div j="v">\` not closed
		`,
	);
});

test('a variant scope opening right before a heading or outside any section holds whole sections', () => {
	checkParse(
		`
		# A
		- [x](#b)
		<div k="w">
		</div>
		<div k="v">

		# B
		<div lang="ru">
		## Б
		</div>
		- [back](#a)
		## C
		</div>
		<div k="x">
		</div>
		# D
		- [d](#a)
		`,
		`
		node a "A" body=""
		{k=v}node b "B" ru="Б" body=""
		{k=v}node c "C" stray body=""
		node d "D" stray body=""
		edge a -[x]-> b
		edge b -[back]-> a
		edge d -[d]-> a
		langs: ru
		dim k: v w x
		warning L12: "C" is unreachable from the first card
		warning L16: "D" is unreachable from the first card
		`,
	);
	checkParse(
		`
		# A
		<div k="v">
		# B
		</div>
		stray text
		<div k="w">
		# C
		<div k="u">
		# D
		</div>
		`,
		`
		node a "A" body=""
		{k=v}node b "B" body=""
		{k=w}node c "C" body=""
		{k=u}node d "D" body=""
		dim k: u v w
		error L5: text outside any card
		error L8: \`<div k>\` inside another
		error L6: \`<div k="w">\` not closed
		`,
	);
});

test('a card in a variant scope shows only with that variant, whatever leads to it', () => {
	const md = `
		# Intro
		- [go](#opening)
		<div german="false">
		- [switch](#switch)
		</div>
		# Opening
		- [plain](#switch)
		<div german="true">
		</div>
		<div german="false">

		# Switch
		- [](#intro)
		</div>
	`;
	checkVisible(md, {}, ['intro', 'opening', 'switch']);
	checkVisible(md, { variants: { german: 'false' } }, ['intro', 'opening', 'switch']);
	checkVisible(md, { variants: { german: 'true' } }, ['intro', 'opening']);
});

const VARIANTS = `
	# Intro
	- [go](#opening)
	# Opening
	<div opener="warm">
	- [next](#warm-pitch)
	</div>
	<div opener="cold">
	- [next](#cold-pitch)
	</div>
	# Warm pitch
	- [ok](#close)
	# Cold pitch
	- [ok](#close)
	- [no](#objection)
	# Objection
	- [handled](#close)
	# Close
	- [again](#intro)
	# Price objection
	- [handled](#close)
`;

test('unselected dims admit every variant; cycles and strays', () => {
	checkVisible(VARIANTS, {}, ['intro', 'opening', 'warm-pitch', 'cold-pitch', 'objection', 'close', 'price-objection']);
});

test('a chosen variant hides what only the other variants reach', () => {
	checkVisible(VARIANTS, { variants: { opener: 'warm' } }, ['intro', 'opening', 'warm-pitch', 'close', 'price-objection']);
});

test('rejoin stays visible through any visible parent', () => {
	checkVisible(VARIANTS, { variants: { opener: 'cold' } }, ['intro', 'opening', 'cold-pitch', 'objection', 'close', 'price-objection']);
});

test('a response scoped to a variant and a language needs both chosen to agree', () => {
	const md = `
		# A
		<div lang="ru">
		<div k="v">
		- [x](#b)
		</div>
		</div>
		# B
	`;
	checkVisible(md, { lang: 'ru', variants: { k: 'v' } }, ['a', 'b']);
	checkVisible(md, { lang: 'ru' }, ['a', 'b']);
	checkVisible(md, { lang: 'en', variants: { k: 'v' } }, ['a']);
	checkVisible(md, { lang: 'ru', variants: { k: 'w' } }, ['a']);
});
