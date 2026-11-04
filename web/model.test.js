const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, visible, inLang } = require('./model.js');

const dedent = s => s.replace(/^\n/, '').replace(/^\t+/gm, '');

function render(graph) {
	return [
		...graph.labels.map(l => `label ${l.name} ${l.color} ${JSON.stringify(l.description)}`),
		...graph.marks.map(m => `mark ${m.dim ?? 'language'}=${m.value}`),
		...graph.nodes.map(n => `node ${n.id} "${n.title}"${n.root ? ' root' : ''}${n.labels.map(l => ` .${l}`).join('')}${Object.entries(n.titles).map(([l, t]) => ` ${l}="${t}"`).join('')} body=${JSON.stringify(n.body.map(l => (l.lang ? `{${l.lang}}${l.text}` : l.text)).join('\n').trim())}`),
		...graph.edges.map(e => `edge ${e.from} -[${e.label}]-> ${e.to}${e.lang ? ` lang=${e.lang}` : ''}`),
		...(graph.langs.length ? [`langs: ${graph.langs.join(' ')}`] : []),
		...Object.entries(graph.dims).map(([k, vs]) => `dim ${k}: ${vs.join(' ')}`),
		...graph.errors.map(e => `error L${e.line}: ${e.msg}`),
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

test('slots, tags and response edges', () => {
	checkParse(
		`
		# Hello, World!
		Say [hi](#opening) warmly.

		- [Has time](#opening)
		- not a [response](#opening) item

		# Opening {opener=warm}
		warm
		# Opening {opener=cold}
		cold
		`,
		`
		node hello-world "Hello, World!" root body="Say [hi](#opening) warmly.\\n\\n- not a [response](#opening) item"
		node opening{opener=warm} "Opening" body="warm"
		node opening{opener=cold} "Opening" body="cold"
		edge hello-world -[Has time]-> opening{opener=warm}
		edge hello-world -[Has time]-> opening{opener=cold}
		dim opener: cold warm
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
		node a "A" root body=""
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
		node a "A" root .l body=""
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
		node a "A" root body=""
		node b "B" body=""
		node c "C" body=""
		edge a -[]-> b
		edge b -[x]-> c
		edge b -[]-> c
		error L5: an unlabeled response must be its card's only one
		`,
	);
});

test('canonical id sorts tag keys', () => {
	checkParse(
		`
		# A {z=1 a=2}
		`,
		`
		node a{a=2 z=1} "A" root body=""
		dim z: 1
		dim a: 2
		`,
	);
});

test('headings and responses inside code fences are body', () => {
	checkParse(
		'# A\n```md\n# Not a node\n- [x](#nowhere)\n```\n~~~\n```\n# still fenced\n~~~\n',
		'node a "A" root body="```md\\n# Not a node\\n- [x](#nowhere)\\n```\\n~~~\\n```\\n# still fenced\\n~~~"',
	);
});

test('parse errors', () => {
	checkParse(
		`
		intro text

		# A
		`,
		`
		node a "A" root body=""
		error L1: text outside any card
		`,
	);
	checkParse(
		`
		# A
		- [x](#b)
		`,
		`
		node a "A" root body=""
		error L2: response links to unknown slot #b
		`,
	);
	checkParse(
		`
		# A {k=v}
		# A {k=v}
		`,
		`
		node a{k=v} "A" root body=""
		node a{k=v} "A" root body=""
		dim k: v
		error L2: duplicate of line 1: same heading and tags
		`,
	);
	checkParse(
		`
		# A
		# B
		- [x](#c)
		# C
		- [y](#b)
		`,
		`
		node a "A" root body=""
		node b "B" body=""
		node c "C" body=""
		edge b -[x]-> c
		edge c -[y]-> b
		error L2: "B" is unreachable from any root
		error L4: "C" is unreachable from any root
		`,
	);
	checkParse('', 'error L1: no headings');
	checkParse('# A {k=1 k=2}\n', 'node a{k=2} "A" root body=""\ndim k: 2\nerror L1: tag key `k` given twice');
});

test('labels are defined before the first heading and attached with `.name`', () => {
	checkParse(
		`
		[hot]: <oklch(0.6 0.2 25)> "Wants it \\"now\\""
		[later]: <oklch(0.55 0.15 145)>

		# A {.hot k=v .later}
		- [x](#b)
		# B {.later}
		`,
		`
		label hot oklch(0.6 0.2 25) "Wants it \\"now\\""
		label later oklch(0.55 0.15 145) ""
		node a{k=v} "A" root .hot .later body=""
		node b "B" .later body=""
		edge a{k=v} -[x]-> b
		dim k: v
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
		node a "A" root .warm .hot body=""
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

		---

		# A {k=v}
		<div lang="ru">
		a
		</div>
		- [x](#b)
		# - Group
		---
		# B {k=w}
		`,
		`
		label l oklch(0 0 0) ""
		mark k=v
		mark language=ru
		node a{k=v} "A" root body="{ru}a"
		node b{k=w} "B" body=""
		edge a{k=v} -[x]-> b{k=w}
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
		# A {k=v}
		`,
		`
		mark k=x
		mark j=v
		mark language=en
		node a{k=v} "A" root body=""
		dim k: v
		error L2: a second mark for \`k\`
		error L1: \`k\` has no variant \`x\`
		error L3: no variant is tagged \`j\`
		error L4: no \`<div lang="en">\`
		`,
	);
});

test('spans locate the text an edit replaces', () => {
	const md = '[l]: <oklch(0 0 0)>\n\n# A {k=v .l} ##\nbody\n- [x](#b)\n# B\n';
	const g = parse(md);
	assert.deepEqual(g.errors, []);
	const [a, b] = g.nodes;
	assert.equal(md.slice(a.attrs.start, a.attrs.end), ' {k=v .l}');
	assert.equal(b.attrs.start, b.attrs.end);
	assert.equal(md.slice(0, b.attrs.start), '[l]: <oklch(0 0 0)>\n\n# A {k=v .l} ##\nbody\n- [x](#b)\n# B');
	assert.equal(md.slice(g.edges[0].start, g.edges[0].end), '- [x](#b)\n');
	assert.equal(md.slice(g.labels[0].start, g.labels[0].end), '[l]: <oklch(0 0 0)>\n');
	assert.deepEqual(g.preamble, { end: md.indexOf('# A'), ruled: false });

	const marked = '[k=v]: #\n\n---\n\n# - G\n# A {k=v}\n';
	const m = parse(marked);
	assert.equal(marked.slice(m.marks[0].start, m.marks[0].end), '[k=v]: #\n');
	assert.deepEqual(m.preamble, { end: marked.indexOf('# - G'), ruled: true });
	assert.equal(parse('---\n[k=v]: #\n# A {k=v}\n').preamble.ruled, false);
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
		node a "A" root ru="А" body="{ru}\\n{ru}Привет\\n{en}Hi\\n\\n> both"
		node b "B" body=""
		edge a -[Да]-> b lang=ru
		edge a -[Yes]-> b lang=en
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
		<div lang="de">
		# A1
		# A2 {k=v .l}
		</div>
		<div lang="de">
		# A3
		</div>
		<div lang="fr">
		# B
		`,
		`
		node a "A" root de="A1" fr="B" body=""
		langs: ru en de fr
		error L3: \`<div lang>\` inside another
		error L7: tags and labels go on the main heading
		error L7: a second \`de\` title
		error L10: a second \`de\` title
		error L12: \`<div lang="fr">\` not closed
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
	assert.equal(inLang({ lang: 'ru' }, { lang: 'en' }), false);
});

const VARIANTS = `
	# Intro
	- [go](#opening)
	# Opening {opener=warm}
	- [next](#warm-pitch)
	# Opening {opener=cold}
	- [next](#cold-pitch)
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

test('unselected dims admit every variant; cycles and multiple roots', () => {
	checkVisible(VARIANTS, {}, [
		'intro',
		'opening{opener=warm}',
		'opening{opener=cold}',
		'warm-pitch',
		'cold-pitch',
		'objection',
		'close',
		'price-objection',
	]);
});

test('excluded variant hides its subtree; slot link resolves to the selected variant', () => {
	checkVisible(VARIANTS, { variants: { opener: 'warm' } }, ['intro', 'opening{opener=warm}', 'warm-pitch', 'close', 'price-objection']);
});

test('rejoin stays visible through any visible parent', () => {
	checkVisible(VARIANTS, { variants: { opener: 'cold' } }, ['intro', 'opening{opener=cold}', 'cold-pitch', 'objection', 'close', 'price-objection']);
});

test('variant root is filtered like any other node', () => {
	const md = `
		# Intro {opener=a}
		- [x](#end)
		# Intro {opener=b}
		- [y](#end)
		# End
	`;
	checkVisible(md, { variants: { opener: 'b' } }, ['intro{opener=b}', 'end']);
});
