// Positions of the visible cards and routes of their edges: dagre ranks and orders, `place` spreads each rank.
// Layouts differ only in which edge of each cycle points back, against the flow; dagre ranks every other edge's target below its source.

// dagre breaks the cycles itself, depth-first: a card ranks below its latest caller
function dfs() {
	return new Set();
}

// cards in the order a call first reaches them, breadth-first from the root, then from each stray: a card ranks below its earliest caller
function bfs(nodes, edges) {
	const next = new Map(nodes.map(n => [n.id, []]));
	for (const e of edges) next.get(e.from).push(e.to);
	const order = new Map();
	for (const n of nodes) {
		if (order.has(n.id)) continue;
		const queue = [n.id];
		order.set(n.id, order.size);
		for (let i = 0; i < queue.length; i++) {
			for (const to of next.get(queue[i])) {
				if (order.has(to)) continue;
				order.set(to, order.size);
				queue.push(to);
			}
		}
	}
	return new Set(edges.filter(e => order.get(e.to) < order.get(e.from)));
}

const BACK_EDGES = { dfs, bfs };
assert(LAYOUTS.length === Object.keys(BACK_EDGES).length && LAYOUTS.every(l => l in BACK_EDGES), 'model.js and layout.js name different layouts');

// nodes: [{id, width, height}] in document order; edges: [{from, to, width, height}], sized by their label.
// Returns each node's {x, y, width, height, rank}, each edge's {points, x, y} from source to target, and the drawing's size
function layout(name, rankdir, spacing, nodes, edges) {
	const back = BACK_EDGES[name](nodes, edges);
	const g = new dagre.graphlib.Graph({ multigraph: true });
	g.setGraph({ rankdir, nodesep: 36 * spacing, ranksep: 60 * spacing, edgesep: 16 * spacing, marginx: 48, marginy: 48 });
	for (const { id, width, height } of nodes) g.setNode(id, { width, height });
	const ends = e => (back.has(e) ? [e.to, e.from] : [e.from, e.to]);
	edges.forEach((e, i) => g.setEdge(...ends(e), { width: e.width, height: e.height, labelpos: 'c' }, String(i)));
	dagre.layout(g);
	place(g);
	const routes = edges.map((e, i) => {
		const { points, x, y } = g.edge(...ends(e), String(i));
		return { points: back.has(e) ? points.toReversed() : points, x, y };
	});
	return { nodes: new Map(nodes.map(n => [n.id, g.node(n.id)])), routes, width: g.graph().width, height: g.graph().height };
}
