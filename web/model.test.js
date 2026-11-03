const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, visible } = require('./model.js');

const dedent = s => s.replace(/^\n/, '').replace(/^\t+/gm, '');

function render(graph) {
	return [
		...graph.nodes.map(n => `node ${n.id} "${n.title}"${n.root ? ' root' : ''} body=${JSON.stringify(n.body.trim())}`),
		...graph.edges.map(e => `edge ${e.from} -[${e.label}]-> ${e.to}`),
		...Object.entries(graph.dims).map(([k, vs]) => `dim ${k}: ${vs.join(' ')}`),
		...graph.errors.map(e => `error L${e.line}: ${e.msg}`),
	].join('\n');
}

function checkParse(md, expected) {
	assert.equal(render(parse(dedent(md))), dedent(expected).trim());
}

function checkVisible(md, variants, expected) {
	const graph = parse(dedent(md));
	assert.deepEqual(graph.errors, []);
	assert.deepEqual([...visible(graph, { variants })].sort(), expected.sort());
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
		error L1: text before the first \`# \` heading
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
	checkParse('', 'error L1: no `# ` headings');
	checkParse('# A {k=1 k=2}\n', 'node a{k=2} "A" root body=""\ndim k: 2\nerror L1: tag key `k` given twice');
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
	checkVisible(VARIANTS, { opener: 'warm' }, ['intro', 'opening{opener=warm}', 'warm-pitch', 'close', 'price-objection']);
});

test('rejoin stays visible through any visible parent', () => {
	checkVisible(VARIANTS, { opener: 'cold' }, ['intro', 'opening{opener=cold}', 'cold-pitch', 'objection', 'close', 'price-objection']);
});

test('variant root is filtered like any other node', () => {
	const md = `
		# Intro {lang=en}
		- [x](#end)
		# Intro {lang=de}
		- [y](#end)
		# End
	`;
	checkVisible(md, { lang: 'de' }, ['intro{lang=de}', 'end']);
});
