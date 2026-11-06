# Architecture
A call script is a markdown file; the caller follows it as a clickable conversation graph in one offline html file, and edits it in place.

```
script.scr.md ──bundle──► script.csr.html (md embedded verbatim + inlined web/ assets)
                               └─ runtime: md ─parse─► graph ─filter(selection)─► layout ─► cards + edges
any edit ─► splice into md ─► reparse ─► rerender
save     ─► same html with the embedded md replaced

watch: script.scr.md ─bundle per request─► http://127.0.0.1 page ─poll /version─► merge into the page's md
       page Ctrl+S ─PUT md─► script.scr.md   (refused if it changed since the page last merged it)
```

- `src/`: the bundler, the `watch` server, and `translate`'s LLM and espeak-ng calls and review. It never parses the format: `translate` runs web/translate.js in an embedded JS engine.
- `web/model.js`: the format's only parser, and its visibility rules; DOM-free.
- `web/layout.js`: dagre's layout of the visible graph, one strategy per layout for which edges point back.
- `web/merge.js`: line-level three-way merge of the page's unsaved edits with the md changed on disk; DOM-free.
- `web/place.js`: cross-axis placement of dagre's layout (Graphviz dot's network-simplex pass); DOM-free.
- `web/view.js`: everything the page does.
- `web/translate.js`: what `translate` asks the LLM and espeak-ng, and where the answers go; not part of the page.

## Invariants
<!-- embed spec/page.md {{{always-->
> [spec/page.md](spec/page.md)
>
> r[page.standalone]
> The html MUST work as a single file opened from `file://`: no server, no CDN, no external reference. `watch` serves that same file; nothing in it may depend on being served.
>
> r[page.md-truth]
> The embedded md MUST be the only source of truth: an edit splices into it and reparses. Nothing serializes the graph back to md.
<!-- /embed }}}always-->

## Format
A script is a `<name>.scr.md` file; its page is titled `<name>`.

```md
[hot]: <oklch(0.62 0.19 25)> "Ready to buy"
[opener=warm]: #

---

# Introduction {.hot}
Hi, this is **Sam** from …

- [Has time](#discovery)
- [Busy](#schedule-callback)

# Opening
<div opener="warm">
…
</div>
```

The md is embedded in a `<script>` block, so it cannot contain `<script` or `</script` (any case).

### Nodes
- Each ATX heading (`#` to `######`, any level) outside a code fence and outside every scope but section scopes starts a node; levels only shape the md elsewhere. Its source span runs to the next such heading or section scope line.
- A heading whose text starts with `-` (`# - Objections`, `## -Notes`) is a **noop**: it ends the current section and starts none, so it only groups sections when the md is read elsewhere. Inside a scope it is ignored.
- Non-blank text outside any section (before the first heading, under a noop, or after a section scope closes), other than label definitions, selection marks, `---` lines and the transcriptions block, is an error.
- A trailing `{.label .label2}` block on the heading is stripped from the title; its tokens are labels. A `k=v` token in it is an error: variants are scopes.
- The GitHub anchor slug of the remaining title is the node's **slot**, its id. Two nodes with the same slot are an error.

### Edges
- A list item consisting of exactly one `[label](#slot)` is a **response**: an edge to the node of that slot. It is removed from the card body and drawn as an edge label. Links inside prose stay links.
- An empty `[](#slot)` is an unlabeled response, drawn as a bare edge; it is an error if its card has another response whose scope it agrees with.
- A response to a slot that has no nodes is an error.
- The first node is the **root**: the call starts there. The graph may rejoin and cycle, back into the root too.
- A node the root does not reach, one no response leads to included, is a **stray**: a warning, not an error. Strays are drawn as if the call could start at them, so they can still be edited and linked.

### Labels
- A line `[name]: <oklch(L C H)> "description"` outside any section defines a label: a link reference definition, so it renders as nothing elsewhere. `name` is `[\w-]+`; the description is optional.
- `.name` in a heading's `{…}` attaches the label. Labels annotate only: they change neither id, slot nor visibility.
- Defining a label twice, attaching an undefined one, or attaching one twice is an error.

### Scopes
- Inside a section, a line `<div key="value">` opens a scope and the next `</div>` line closes the innermost open one; key and value are `[\w-]+`. Both lines are removed from the card body. The md renders as plain html divs elsewhere.
- Inside a body line outside code fences, `<div key="value">text</div>` is an **inline** scope: the line splits into one line per combination of its inline scopes' values, each keeping only its own values' text and belonging to those scopes too.
- `<div lang="code">` is a **language** scope; any other key is a variant **dimension** (an A/B split), `<div opener="warm">`.
- A body line or response belongs to every scope open around it, and agrees with a selection unless one of them has a different value chosen for its key. A card's variants share its slot, so links into it never name a variant.
- A variant scope opened outside any section, or opened outside every in-section scope with a heading as its next non-blank line, is a **section scope**: its `<div>` and `</div>` lines end the current section, and every node headed inside it belongs to its variant. Such a node is visible only when its variant agrees with the selection, whatever response leads to it; its own lines and responses belong to the scopes opened inside its section alone.
- Scopes of different keys nest either way; one inside another of the same key, or one never closed, is an error.
- Languages are the union of the language codes, in order of first appearance; dimensions and their values are the union of the variant scopes. Nothing is declared.
- A heading inside language scopes alone is the card's title in that language. It starts no node: slot and labels come from the main heading alone. A second title for one language in a section, a `{…}` block on it, or a heading inside a variant scope is an error.

### Translating
`scripters translate <md> --from <code> --to <code>` fills one language from another. Only prose reaches the LLM, one bit per call, each distinct text once: a title, a line, or a response's label; indent, quote and list markers, `<div>` lines, slots and fenced code are copied around it.
- A section with no language scope is wrapped whole in `<div lang="from">`.
- Each `from` block gets a `to` sibling right after it: the same lines translated, a line wrapped onto the next joined into one, and, for the section's first block outside any variant that holds no heading, the main title one level down as its title.
- `from` and `to` blocks pair up in order within the same enclosing variants. A section with languages but no `from` block in some variants, or a count of `to` blocks other than none or as many, is an error.
- Lines outside every language scope of a section that has some stay as they are.
- An existing `to` block the translation would change is shown by `cargo insta review`: accepted ones are overwritten, the rest stay. The md is written once, at the end, and only if every call answered and the result parses.
- `scripters translate regenerate-all <md> --from-lang <code> [--langs <code>,…]` does the same for each of `--langs` (every language of the md but `from` by default), with one review across them. New blocks follow their `from` block in `--langs` order; existing ones stay where they are.

### Transcriptions
`scripters translate transcribe <md> --langs <code>,<code>…` caches espeak-ng's IPA of each line of the named languages' blocks in the md, in place.
- A block is one `<div lang>` scope of a section, keyed by its language and a digest of its text from `<div` to `</div>`: editing it leaves it untranscribed.
- Its body lines and title, outside code fences, are read one at a time, with markdown, list, quote and heading markers dropped; a line with no letters is not read, nor are responses. A line split by inline scopes is read once per combination.
- The cache is a block `<details><summary>transcriptions</summary>` … `</details>` outside every scope; it ends the section before it. Each non-blank line in it is the json `{"lang", "hash", "ipa"}` of one block, `ipa` holding per line after its `<div lang>` the IPA, null, or for a split line an array of those per combination. A second cache, a line of another shape, or two for one language and digest is an error.
- Only blocks without a transcription of their text are read. The cache is rewritten at the bottom, in md order, keeping one entry per current block: an edited or deleted block's goes.
- On the page, hovering a line or title of a block with a transcription of its text shows the line's IPA.

### Marks
- A line `[dim=value]: #`, `[lang="code"]: #` or `[layout="bfs"]: #` outside any section marks a chosen variant value, the chosen language, or the layout: a link reference definition, so it renders as nothing elsewhere.
- A page with no selection of its own starts from the marks; `--layout` outranks the layout mark.
- A second mark for one dim (or a second language or layout mark), a value with no scope for it, or a layout other than `dfs` and `bfs`, is an error.

### Saving
Ctrl+S and Export ▾ .html / .md write the md as it is, except:
- Marks follow the current selection, one per chosen dim, one for the language and one for the layout: a changed one is rewritten in place, one for a dim no longer chosen is dropped, new ones go after the last mark, or after the labels if there is none.
- If anything precedes the first heading, a `---` line follows it, unless the last such line already is one.

### Layout
Every response leads one rank or more down, except one in each loop, which points back up. The layout picks it:
- `bfs`: cards are ordered as a call first reaches them, breadth-first from the root, then from each stray; a response into an earlier card points back, so a card ranks below the earliest card leading to it.
- `dfs` (the default): dagre's depth-first cycle breaking; a card ranks below the latest card leading to it.

### Editing
- An edit whose result has errors is refused.
- Deleting a card removes its section and the responses into its slot.
- Renaming or deleting a label rewrites every heading carrying it.
- Undo (`u`, Ctrl+Z) and redo (`U`, Ctrl+Y, Ctrl+Shift+Z) step through this page's edits; the history lives in page memory, not the md.
- Under `watch`, a change of the md on disk is an edit too: the page's unsaved edits merge into it by lines. Where both change the same lines, or the merge has errors, the page shows the disk's md and undo brings its edits back. An open card editor holds the change off until it closes.
- Ctrl+S in a card editor commits it first.
- New card (⊞, `N`) appends `# New card` to the md, numbered past any slot it would collide with, and opens its editor.
- A script with no cards shows a circled + in the middle of the page that does the same; `--new` starts `build` and `watch` on such an empty md when it does not exist yet.
- Dragging a card's handle onto another card adds the response `- [TODO](#slot)` into that card's slot, after the dragged card's last response outside any scope, or at the end of its section if it has none.

### Selection
`{ variants: {dim → value}, lang, layout, path: [nodeId], calling: bool }`, kept in `sessionStorage`; a new tab starts from the md's marks. A dim without a value is not chosen yet and admits every variant.

- A node is **visible** iff it agrees with the selection and is reachable from the root or a stray along responses and nodes that agree with it.
- Cards show only the lines that agree with the selection. Lines and responses of a dimension with no value chosen show framed with their variant. Unlike variants, a language is always chosen while the document has any.
- After every reparse, path entries and variant values absent from the document are dropped; an absent language becomes the document's first.
- Clicking a card or edge label appends it to the path; clicking a framed variant, a response's label, or a card in a section scope also chooses the variants it is framed with.
- `c` scrolls to the start; once there, it is New call. New call empties the path and starts calling; Clear (Esc while not editing) empties the path and stops calling.
- While calling, every click scrolls its card and the cards it leads to into view at once.
- Backspace deletes the current card.
