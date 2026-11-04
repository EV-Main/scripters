// Line-level three-way merge: `ours` and `theirs` each edited `base`; null if they edit the same lines or insert at the same point.
// Identical edits on both sides count as a clash too.
function merge(base, ours, theirs) {
	const b = base.split('\n');
	const hunks = [...changes(b, ours.split('\n')), ...changes(b, theirs.split('\n'))].sort((x, y) => x.start - y.start || x.end - y.end);
	const out = [];
	let at = 0;
	for (const [i, h] of hunks.entries()) {
		const next = hunks[i + 1];
		if (next && (next.start < h.end || next.start === h.start)) return null;
		out.push(...b.slice(at, h.start), ...h.lines);
		at = h.end;
	}
	out.push(...b.slice(at));
	return out.join('\n');
}

// what turns `a` into `b`, as [{start, end, lines}]: a[start..end) replaced by `lines`, along a longest common subsequence
function changes(a, b) {
	const lcs = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1)); // of the suffixes a[i..], b[j..]
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const hunks = [];
	let [i, j] = [0, 0];
	while (i < a.length || j < b.length) {
		if (a[i] === b[j] && i < a.length && j < b.length) {
			i++;
			j++;
			continue;
		}
		const h = { start: i, end: i, lines: [] };
		while ((i < a.length || j < b.length) && !(a[i] === b[j] && i < a.length && j < b.length)) {
			if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) h.lines.push(b[j++]);
			else h.end = ++i;
		}
		hunks.push(h);
	}
	return hunks;
}

if (typeof module !== 'undefined') module.exports = { merge };
