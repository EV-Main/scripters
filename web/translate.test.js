const test = require('node:test');
const assert = require('node:assert/strict');
const { bits, apply, untranscribed, transcribe } = require('./translate.js');

const dedent = s => s.replace(/^\n/, '').replace(/^\t+/gm, '');

// with a fake translator that brackets every text, so what got translated is visible
function check(md, overwrite, expected, from = 'en', tos = ['es']) {
	md = dedent(md);
	let actual;
	try {
		const texts = bits(md, from, tos);
		for (const ts of Object.values(texts)) assert.equal(new Set(ts).size, ts.length, 'each text asked once');
		const maps = Object.fromEntries(Object.entries(texts).map(([l, ts]) => [l, Object.fromEntries(ts.map(t => [t, `<${t}>`]))]));
		const r = apply(md, from, tos, maps, overwrite);
		actual = r.md + r.conflicts.map(c => `\nconflict ${c.lang} ${c.key} "${c.title}":\n${c.old}=>\n${c.new}`).join('');
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
		{},
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
		{},
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
		{},
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
		'fr',
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
		{},
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
		{},
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
		{},
		`
		${existing}
		conflict es intro "Intro":
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
		{ es: ['intro'] },
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

test('many languages at once: new blocks follow their `from` one in order, a section is wrapped once, conflicts carry their language', () => {
	check(
		`
		# Intro
		<div lang="en">
		Hello.
		</div>
		<div lang="es">
		Hola.
		</div>

		# Next
		Hi.

		# End
		`,
		{},
`
		# Intro
		<div lang="en">
		Hello.
		</div>
		<div lang="de">
		## <Intro>
		<Hello.>
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
		<div lang="de">

		## <Next>
		<Hi.>
		</div>

		# End
		<div lang="es">
		## <End>
		</div>
		<div lang="de">
		## <End>
		</div>

		conflict es intro "Intro":
		<div lang="es">
		Hola.
		</div>
		=>
		<div lang="es">
		## <Intro>
		<Hello.>
		</div>
		`,
		'en',
		['es', 'de'],
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
		{},
		`
		error: #intro: no \`en\` block
		#close: 2 \`en\` blocks but 1 \`es\` within {"offer":"demo"}
		`,
	);
});

test('a response label translated into one holding a bracket is an error', () => {
	const md = '# A\n- [Yes](#a)\n';
	assert.throws(() => apply(md, 'en', ['es'], { es: { A: 'A', Yes: 'Sí [ok]' } }, {}), /#a: the `es` translation of the response `Yes` holds a bracket/);
});

// with a fake espeak-ng that slashes every prose, so what got read is visible
function checkTranscribe(md, langs, expected) {
	md = dedent(md);
	let actual;
	try {
		const asked = untranscribed(md, langs);
		const ipa = Object.fromEntries(Object.entries(asked).map(([l, prose]) => [l, Object.fromEntries(prose.map(p => [p, `/${p}/`]))]));
		actual = `${Object.entries(asked).flatMap(([l, prose]) => prose.map(p => `asked ${l}: ${p}`)).join('\n')}\n${transcribe(md, langs, ipa)}`;
	} catch (e) {
		actual = `error: ${e.message}`;
	}
	assert.equal(actual.trim(), dedent(expected).trim());
}

const SCRIPT = `
	# A
	<div lang="en">
	## Hello
	Hi, this is **Sam** from [Acme](https://acme.io).
	- <div k="v">Point</div><div k="w">Item</div> one
	> quoted
	\`\`\`
	code
	\`\`\`
	- [Yes](#b)
	</div>
	<div lang="ru">
	Привет
	</div>
	# B
	<div lang="en">
	Bye
	</div>
	`;

test('each line of a language\'s blocks is read, its ipa cached at the bottom by block and line', () => {
	checkTranscribe(
		SCRIPT,
		['en'],
		`
		asked en: Hello
		asked en: Hi, this is Sam from Acme.
		asked en: Point one
		asked en: Item one
		asked en: quoted
		asked en: Bye
		# A
		<div lang="en">
		## Hello
		Hi, this is **Sam** from [Acme](https://acme.io).
		- <div k="v">Point</div><div k="w">Item</div> one
		> quoted
		\`\`\`
		code
		\`\`\`
		- [Yes](#b)
		</div>
		<div lang="ru">
		Привет
		</div>
		# B
		<div lang="en">
		Bye
		</div>

		<details><summary>transcriptions</summary>

		{"lang":"en","hash":"244612c835b30","ipa":["/Hello/","/Hi, this is Sam from Acme./",["/Point one/","/Item one/"],"/quoted/"]}
		{"lang":"en","hash":"1db176de5cee60","ipa":["/Bye/"]}

		</details>
		`,
	);
});

test('only blocks changed since their transcription are read again; a changed block\'s old one goes', () => {
	const once = transcribe(dedent(SCRIPT), ['en', 'ru'], { en: { Hello: 'h', 'Hi, this is Sam from Acme.': 'hi', 'Point one': 'p', 'Item one': 'i', quoted: 'q', Bye: 'b' }, ru: { Привет: 'p' } });
	checkTranscribe(
		once.replace('Bye', 'Bye now'),
		['en'],
		`
		asked en: Bye now
		# A
		<div lang="en">
		## Hello
		Hi, this is **Sam** from [Acme](https://acme.io).
		- <div k="v">Point</div><div k="w">Item</div> one
		> quoted
		\`\`\`
		code
		\`\`\`
		- [Yes](#b)
		</div>
		<div lang="ru">
		Привет
		</div>
		# B
		<div lang="en">
		Bye now
		</div>

		<details><summary>transcriptions</summary>

		{"lang":"en","hash":"244612c835b30","ipa":["h","hi",["p","i"],"q"]}
		{"lang":"ru","hash":"10627665689db3","ipa":["p"]}
		{"lang":"en","hash":"6c853f2a72dd8","ipa":["/Bye now/"]}

		</details>
		`,
	);
	checkTranscribe('# A\n<div lang="en">\nHi\n</div>\n', ['de'], 'error: no `<div lang="de">`');
	checkTranscribe('# A\nHi\n', [], '# A\nHi');
});
