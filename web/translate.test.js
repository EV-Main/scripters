const test = require('node:test');
const assert = require('node:assert/strict');
const { bits, apply } = require('./translate.js');

const dedent = s => s.replace(/^\n/, '').replace(/^\t+/gm, '');

// with a fake translator that brackets every text, so what got translated is visible
function check(md, overwrite, expected, [from, to] = ['en', 'es']) {
	md = dedent(md);
	let actual;
	try {
		const texts = bits(md, from, to);
		assert.equal(new Set(texts).size, texts.length, 'each text asked once');
		const r = apply(md, from, to, Object.fromEntries(texts.map(t => [t, `<${t}>`])), overwrite);
		actual = r.md + r.conflicts.map(c => `\nconflict ${c.key} "${c.title}":\n${c.old}=>\n${c.new}`).join('');
	} catch (e) {
		actual = `error: ${e.message}`;
	}
	assert.equal(actual.trim(), dedent(expected).trim());
}

test('a section without languages is wrapped in `from`, and gets a `to` sibling titled one level down', () => {
	check(
		`
		[x]: <oklch(0.5 0.1 10)>

		# Hello {.x}
		Hi, this is **Sam**,
		  calling about [the offer](https://x.y).

		- Point one
		  wrapped on.
		> Quoted
		> > deeper
		---

		- [Yes](#bye)

		## Bye
		- [](#end)
		## End
		`,
		[],
		`
		[x]: <oklch(0.5 0.1 10)>

		# Hello {.x}
		<div lang="en">

		Hi, this is **Sam**,
		  calling about [the offer](https://x.y).

		- Point one
		  wrapped on.
		> Quoted
		> > deeper
		---

		- [Yes](#bye)
		</div>
		<div lang="es">

		## <Hello>
		<Hi, this is **Sam**, calling about [the offer](https://x.y).>

		- <Point one wrapped on.>
		> <Quoted>
		> > <deeper>
		---

		- [<Yes>](#bye)
		</div>

		## Bye
		<div lang="en">

		- [](#end)
		</div>
		<div lang="es">

		### <Bye>
		- [](#end)
		</div>
		## End
		<div lang="es">
		### <End>
		</div>
		`,
	);
});

test('an existing `from` block gets its sibling right after it; neutral lines stay', () => {
	check(
		`
		# Intro
		<div lang="en">

		Hello.
		</div>
		<div lang="fr">

		## Présentation
		Bonjour.
		</div>

		> Pause.
		`,
		[],
		`
		# Intro
		<div lang="en">

		Hello.
		</div>
		<div lang="es">

		## <Intro>
		<Hello.>
		</div>
		<div lang="fr">

		## Présentation
		Bonjour.
		</div>

		> Pause.
		`,
	);
});

test("a `from` block's own heading is translated in place of the main title", () => {
	check(
		`
		# Intro
		<div lang="fr">

		## Présentation
		Bonjour.
		</div>
		`,
		[],
		`
		# Intro
		<div lang="fr">

		## Présentation
		Bonjour.
		</div>
		<div lang="es">

		## <Présentation>
		<Bonjour.>
		</div>
		`,
		['fr', 'es'],
	);
});

test('variants inside a wrapped section are copied; languages inside variants pair up per variant, untitled', () => {
	check(
		`
		# Opening
		<div opener="warm">
		Great.
		</div>
		<div opener="cold">
		Thanks.
		</div>

		# Close
		<div offer="demo">
		<div lang="en">
		Demo?
		</div>
		</div>
		<div offer="trial">
		<div lang="en">
		Trial?
		</div>
		</div>
		`,
		[],
		`
		# Opening
		<div lang="en">

		<div opener="warm">
		Great.
		</div>
		<div opener="cold">
		Thanks.
		</div>
		</div>
		<div lang="es">

		## <Opening>
		<div opener="warm">
		<Great.>
		</div>
		<div opener="cold">
		<Thanks.>
		</div>
		</div>

		# Close
		<div offer="demo">
		<div lang="en">
		Demo?
		</div>
		<div lang="es">
		<Demo?>
		</div>
		</div>
		<div offer="trial">
		<div lang="en">
		Trial?
		</div>
		<div lang="es">
		<Trial?>
		</div>
		</div>
		`,
	);
});

test('fenced code is copied as is', () => {
	check(
		`
		# A
		Run:
		\`\`\`sh
		echo hi
		- [not](#a)
		\`\`\`
		`,
		[],
		`
		# A
		<div lang="en">

		Run:
		\`\`\`sh
		echo hi
		- [not](#a)
		\`\`\`
		</div>
		<div lang="es">

		## <A>
		<Run:>
		\`\`\`sh
		echo hi
		- [not](#a)
		\`\`\`
		</div>
		`,
	);
});

const existing = `
	# Intro
	<div lang="en">
	Hello.
	</div>
	<div lang="es">
	Hola.
	</div>

	# Next
	<div lang="en">
	Hi.
	</div>
	<div lang="es">
	## <Next>
	<Hi.>
	</div>
	`;

test('an existing `to` block that differs is a conflict, left as is; an equal one is not', () => {
	check(
		existing,
		[],
		`
		${existing}
		conflict intro "Intro":
		<div lang="es">
		Hola.
		</div>
		=>
		<div lang="es">
		## <Intro>
		<Hello.>
		</div>
		`,
	);
});

test('a conflict named in `overwrite` is replaced by the translation', () => {
	check(
		existing,
		['intro'],
		`
		# Intro
		<div lang="en">
		Hello.
		</div>
		<div lang="es">
		## <Intro>
		<Hello.>
		</div>

		# Next
		<div lang="en">
		Hi.
		</div>
		<div lang="es">
		## <Next>
		<Hi.>
		</div>
		`,
	);
});

test('a section whose languages do not include `from`, or pair up unevenly, is an error', () => {
	check(
		`
		# Intro
		<div lang="fr">
		Bonjour.
		</div>

		# Close
		<div offer="demo">
		<div lang="en">
		Demo?
		</div>
		<div lang="en">
		Demo!
		</div>
		<div lang="es">
		Demo?
		</div>
		</div>
		`,
		[],
		`
		error: #intro: no \`en\` block
		#close: 2 \`en\` blocks but 1 \`es\` within {"offer":"demo"}
		`,
	);
});

test('a response label translated into one holding a bracket is an error', () => {
	const md = '# A\n- [Yes](#a)\n';
	assert.throws(() => apply(md, 'en', 'es', { A: 'A', Yes: 'Sí [ok]' }, []), /#a: the translation of the response `Yes` holds a bracket/);
});
