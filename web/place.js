// Re-places a laid-out dagre graph across the rank axis: Graphviz dot's x-coordinate pass (Gansner et al. 1993, §4.2), in place of dagre's Brandes–Köpf.
// Ranks and in-layer order stay dagre's. The layered graph is rebuilt from dagre's output, whose shape `layout()` fixes; each reading of it is asserted.
const CENTRING = 5; // each card's pull toward the top rank, against dot's segment weights of 1, 2 and 8: weaker leaves the top in a corner, stronger bends long edges

function place(g) {
	const { rankdir, nodesep, edgesep, marginx, marginy } = g.graph();
	assert(rankdir === 'TB' || rankdir === 'LR', `place handles rankdir TB and LR, got ${rankdir}`);
	const [axis, cross, crossSize, margin] = rankdir === 'TB' ? ['y', 'x', 'width', marginx] : ['x', 'y', 'height', marginy];

	const members = []; // {at, lo, hi, dummy: {lo, hi}}: a card (with its self-loops) or an edge dummy, as extents around `at`
	const layers = new Map(); // axis coordinate → members
	const member = (p, m) => {
		if (!layers.has(p[axis])) layers.set(p[axis], []);
		layers.get(p[axis]).push(members.length);
		members.push({ at: p[cross], ...m });
		return members.length - 1;
	};

	const placed = l => 'x' in l; // dagre positions no label of zero size, except on self-loops

	const cards = new Map(g.nodes().map(v => {
		const n = g.node(v);
		const loops = g.outEdges(v, v).map(e => g.edge(e));
		for (const l of loops) assert(l.points.length === 7 && l[axis] === n[axis], `self-loop on ${v} is not dagre's five-point loop around a dummy beside it`);
		const reach = Math.max(n[cross] + n[crossSize] / 2, ...loops.flatMap(l => [...l.points.map(p => p[cross]), l[cross] + l[crossSize] / 2]));
		return [v, member(n, { lo: n[crossSize] / 2, hi: reach - n[cross], dummy: { lo: false, hi: loops.length > 0 } })];
	}));

	const chains = g.edges().filter(e => e.v !== e.w).map(e => {
		const l = g.edge(e);
		const inner = l.points.slice(1, -1); // the ends are where dagre cut the edge at its cards' borders
		assert(inner.length >= 1, `edge ${e.v}→${e.w} crosses no layer; dagre no longer doubles ranks for labels`);
		const labelAt = placed(l) ? inner.findIndex(p => p[axis] === l[axis] && p[cross] === l[cross]) : -1;
		assert(!placed(l) || labelAt >= 0, `edge ${e.v}→${e.w}'s label sits on none of its dummies`);
		const dummies = inner.map((p, i) => member(p, { lo: i === labelAt ? l[crossSize] / 2 : 0, hi: i === labelAt ? l[crossSize] / 2 : 0, dummy: { lo: true, hi: true } }));
		return { e, l, labelAt, dummies, chain: [cards.get(e.v), ...dummies, cards.get(e.w)] };
	});

	const aux = new dagre.graphlib.Graph();
	members.forEach((_, i) => aux.setNode(String(i), {}));
	for (const ms of layers.values()) {
		ms.sort((a, b) => members[a].at - members[b].at);
		ms.forEach((b, i) => {
			if (!i) return;
			const [ma, mb] = [members[ms[i - 1]], members[b]];
			assert(ma.at < mb.at, 'two members of a layer share a cross coordinate');
			// integral: the solver tests slack against 0 exactly, and float slack of ±1e-15 never tightens
			const minlen = Math.ceil(ma.hi + mb.lo + ((ma.dummy.hi ? edgesep : nodesep) + (mb.dummy.lo ? edgesep : nodesep)) / 2);
			aux.setEdge(String(ms[i - 1]), String(b), { minlen, weight: 0 });
		});
	}
	let helpers = 0;
	const tie = (u, v, weight) => { // dot's helper node: costs weight·|x_u − x_v|
		const h = `h${helpers++}`;
		aux.setNode(h, {});
		for (const m of [u, v]) aux.setEdge(h, m, { minlen: 0, weight });
	};
	for (const { chain } of chains)
		chain.slice(1).forEach((v, i) => {
			const u = chain[i];
			const omega = [u, v].filter(m => members[m].dummy.lo).length; // dot's Ω: 1, 2, 8 for real–real, real–dummy, dummy–dummy, so long edges run straight
			tie(String(u), String(v), [1, 2, 8][omega]);
		});
	// an anchor held within the top rank, which every other card pulls toward: the body balances around the call's start, where the page opens.
	// Being tied to every card, it also connects the graph, which the solver needs: variant filtering can leave components that share no layer
	const top = Math.min(...[...cards.keys()].map(v => g.node(v)[axis]));
	const [first, rest] = [...cards].reduce(([f, r], [v, i]) => (g.node(v)[axis] === top ? [[...f, i], r] : [f, [...r, i]]), [[], []]);
	aux.setNode('c', {});
	for (const i of rest) tie('c', String(i), CENTRING);
	for (const i of first) tie('c', String(i), rest.length * CENTRING + 1); // outweighs the rest together, so the anchor stays within the top rank
	// dagre's networkSimplex() starts from longest-path ranks; dagre's own placement is a far closer start, and the iterations it saves dominate the cost
	const start = members.map(m => Math.round(m.at));
	for (const ms of layers.values()) ms.forEach((b, i) => i && (start[b] = Math.max(start[b], start[ms[i - 1]] + aux.edge(String(ms[i - 1]), String(b)).minlen)));
	start.forEach((x, i) => (aux.node(String(i)).rank = x));
	aux.node('c').rank = start[0];
	for (const v of aux.nodes()) if (v[0] === 'h') aux.node(v).rank = Math.min(...aux.successors(v).map(w => aux.node(w).rank));
	const ns = dagre.networkSimplex;
	const tree = ns.feasibleTree(aux);
	ns.initLowLimValues(tree);
	ns.initCutValues(tree, aux);
	for (let e; (e = ns.leaveEdge(tree)); ) ns.exchangeEdges(tree, aux, e, ns.enterEdge(tree, aux, e));
	const to = members.map((_, i) => aux.node(String(i)).rank);

	for (const [v, i] of cards) {
		const n = g.node(v);
		const by = to[i] - n[cross];
		n[cross] = to[i];
		for (const e of g.outEdges(v, v)) {
			const l = g.edge(e);
			for (const p of [...l.points, l]) p[cross] += by;
		}
	}
	for (const { e, l, labelAt, dummies } of chains) {
		const { points } = l;
		dummies.forEach((m, i) => (points[i + 1][cross] = to[m]));
		if (labelAt >= 0) l[cross] = to[dummies[labelAt]];
		points[0] = dagre.util.intersectRect(g.node(e.v), points[1]);
		points[points.length - 1] = dagre.util.intersectRect(g.node(e.w), points.at(-2));
	}

	const spans = [
		...g.nodes().map(v => g.node(v)),
		...g.edges().flatMap(e => {
			const l = g.edge(e);
			return [...(placed(l) ? [l] : []), ...l.points.map(p => ({ [cross]: p[cross], [crossSize]: 0 }))];
		}),
	];
	const lo = Math.min(...spans.map(s => s[cross] - s[crossSize] / 2));
	const hi = Math.max(...spans.map(s => s[cross] + s[crossSize] / 2));
	for (const v of g.nodes()) g.node(v)[cross] += margin - lo;
	for (const e of g.edges()) {
		const l = g.edge(e);
		for (const p of [...l.points, ...(placed(l) ? [l] : [])]) p[cross] += margin - lo;
	}
	g.graph()[crossSize] = hi - lo + 2 * margin;
}

function assert(ok, msg) {
	if (!ok) throw new Error(msg);
}

if (typeof module !== 'undefined') module.exports = { place };
