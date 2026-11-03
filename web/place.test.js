const test = require('node:test');
const assert = require('node:assert/strict');
const dagre = (globalThis.dagre = require('./vendor/dagre.min.js')); // place.js reads it as the page's global
const { place } = require('./place.js');

// nodes: {id: [rank, width, height]}, ranked as view.js's slot ranking does; edges: [from, to, label width, label height], from the upper rank
function layout(rankdir, nodes, edges) {
	const g = new dagre.graphlib.Graph({ multigraph: true });
	const top = Math.min(...Object.values(nodes).map(([rank]) => rank));
	const ranker = lg => {
		for (const v of lg.nodes()) lg.node(v).rank = v in nodes ? nodes[v][0] : top - 1;
	};
	g.setGraph({ rankdir, ranker, nodesep: 36, ranksep: 60, edgesep: 16, marginx: 48, marginy: 48 });
	for (const [id, [, width, height]] of Object.entries(nodes)) g.setNode(id, { width, height });
	edges.forEach(([v, w, width, height], i) => g.setEdge(v, w, { width, height, labelpos: 'c' }, String(i)));
	dagre.layout(g);
	return g;
}

const axes = g => (g.graph().rankdir === 'TB' ? ['y', 'x', 'width'] : ['x', 'y', 'height']);

// the reported script, sizes as the page measured them: two introduction variants over opening, whose wide fan-out leans to one side
const reported = [
	{
		intro0: [0, 336, 195], intro1: [0, 336, 174], opening: [2, 336, 223], who: [4, 336, 139], pitch: [4, 336, 181], close0: [6, 336, 160], close1: [6, 336, 181], anything: [8, 336, 195], booked: [8, 336, 123],
		timing: [10, 336, 160], competitor: [10, 336, 139], think: [10, 336, 181], price: [12, 336, 160], partner: [12, 336, 160], doubt: [12, 336, 202], schedule: [12, 336, 144], not: [14, 336, 144],
	},
	[
		['intro0', 'opening', 25, 22], ['intro1', 'opening', 92, 22], ['opening', 'schedule', 105, 22], ['opening', 'who', 88, 22], ['opening', 'pitch', 76, 22], ['opening', 'who', 88, 22], ['who', 'not', 101, 22],
		['pitch', 'close0', 93, 22], ['pitch', 'close1', 93, 22], ['pitch', 'price', 100, 22], ['pitch', 'competitor', 154, 37], ['pitch', 'think', 139, 22],
		['close0', 'anything', 85, 22], ['close1', 'anything', 85, 22], ['anything', 'price', 47, 22], ['anything', 'timing', 58, 22], ['anything', 'competitor', 113, 22], ['anything', 'partner', 149, 22],
		['anything', 'think', 102, 22], ['anything', 'doubt', 111, 22], ['anything', 'price', 154, 37], ['price', 'not', 98, 22], ['anything', 'timing', 72, 22], ['timing', 'schedule', 103, 22],
		['anything', 'competitor', 129, 22], ['competitor', 'not', 95, 22], ['anything', 'partner', 147, 22], ['partner', 'not', 99, 22], ['think', 'price', 83, 22], ['think', 'doubt', 120, 22],
		['think', 'partner', 147, 22], ['close0', 'think', 111, 22], ['close1', 'think', 111, 22], ['anything', 'doubt', 106, 22], ['doubt', 'not', 95, 22], ['close0', 'booked', 88, 22],
		['close0', 'anything', 73, 22], ['close0', 'schedule', 105, 22], ['close1', 'booked', 102, 22], ['close1', 'anything', 73, 22],
	],
];

// self-loops, parallel edges and edges spanning many ranks
const tangled = [
	Object.fromEntries(Object.entries({ a: 0, b: 2, c: 2, d: 4, e: 8, f: 6 }).map(([id, rank]) => [id, [rank, 220, 110]])),
	[['a', 'b'], ['a', 'b'], ['a', 'c'], ['b', 'b'], ['b', 'b'], ['a', 'e'], ['c', 'e'], ['b', 'd'], ['d', 'd'], ['d', 'e'], ['c', 'f'], ['a', 'f'], ['f', 'f']].map(e => [...e, 70, 18]),
];

for (const rankdir of ['TB', 'LR'])
	test(`${rankdir}: the top rank is centred`, () => {
		const g = layout(rankdir, ...reported);
		place(g);
		const [, cross, crossSize] = axes(g);
		const top = ['intro0', 'intro1'].map(id => g.node(id));
		const lo = Math.min(...top.map(n => n[cross] - n[crossSize] / 2));
		const hi = Math.max(...top.map(n => n[cross] + n[crossSize] / 2));
		const span = g.graph()[crossSize];
		assert.ok(Math.abs((lo + hi) / 2 - span / 2) < span * 0.1, // a bias in an L1 objective, not a constraint: it moves in jumps
			`top rank centre ${(lo + hi) / 2} in a ${span} wide graph`);
	});

// members of each layer in cross order: cards, and the dummies an edge's interior points stand for
function layers(g) {
	const [axis, cross, crossSize] = axes(g);
	const at = new Map();
	const add = (key, p, size, dummy) => {
		if (!at.has(p[axis])) at.set(p[axis], []);
		at.get(p[axis]).push({ key, at: p[cross], size, dummy });
	};
	for (const v of g.nodes()) {
		const n = g.node(v);
		const loops = g.outEdges(v, v).map(e => g.edge(e));
		const reach = Math.max(n[cross] + n[crossSize] / 2, ...loops.flatMap(l => [...l.points.map(p => p[cross]), l[cross] + l[crossSize] / 2]));
		add(v, n, { lo: n[crossSize] / 2, hi: reach - n[cross] }, { lo: false, hi: loops.length > 0 });
	}
	for (const e of g.edges()) {
		if (e.v === e.w) continue;
		const l = g.edge(e);
		l.points.slice(1, -1).forEach((p, i) => add(`${e.name}:${i}`, p, p[cross] === l[cross] && p[axis] === l[axis] ? { lo: l[crossSize] / 2, hi: l[crossSize] / 2 } : { lo: 0, hi: 0 }, { lo: true, hi: true }));
	}
	return [...at.values()].map(ms => ms.sort((a, b) => a.at - b.at));
}

for (const rankdir of ['TB', 'LR'])
	for (const [name, shape] of Object.entries({ reported, tangled }))
		test(`${rankdir} ${name}: layer order kept, neighbours separated`, () => {
			const g = layout(rankdir, ...shape);
			const before = layers(g).map(ms => ms.map(m => m.key));
			place(g);
			const after = layers(g);
			assert.deepEqual(after.map(ms => ms.map(m => m.key)).sort(), before.sort());
			const { nodesep, edgesep } = g.graph();
			for (const ms of after)
				for (let i = 1; i < ms.length; i++) {
					const [a, b] = [ms[i - 1], ms[i]];
					const sep = a.size.hi + b.size.lo + ((a.dummy.hi ? edgesep : nodesep) + (b.dummy.lo ? edgesep : nodesep)) / 2;
					assert.ok(b.at - a.at >= sep - 1e-9, `${a.key} and ${b.key} are ${b.at - a.at} apart, need ${sep}`);
				}
		});
