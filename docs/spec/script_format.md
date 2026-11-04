# Script format
```md
[hot]: <oklch(0.62 0.19 25)> "Ready to buy"
[opener=warm]: #

---

# Introduction {.hot}
Hi, this is **Sam** from …

- [Has time](#discovery)
- [Busy](#schedule-callback)

# Opening {opener=warm}
…
```

## Nodes
- Each ATX heading (`#` to `######`, any level) outside a code fence and a language scope starts a node; levels only shape the md elsewhere. Its source span runs to the next such heading.
- A heading whose text starts with `-` (`# - Objections`, `## -Notes`) is a **noop**: it ends the current section and starts none, so it only groups sections when the md is read elsewhere. Inside a language scope it is ignored.
- Non-blank text outside any section (before the first heading, or under a noop), other than label definitions, selection marks and `---` lines, is an error.
- A trailing `{k=v k2=v2 .label}` block on the heading is stripped from the title. Its `k=v` tokens are the node's variant tag; `.name` tokens are labels.
- The GitHub anchor slug of the remaining title is the node's **slot**. Variants of one step share a title, so `# Opening {opener=warm}` and `# Opening {opener=cold}` both fill `#opening`.
- Node id = slot + sorted tag set. Two nodes with the same id are an error.
- Variant dimensions and their values are the union of all tags; nothing is declared.

## Edges
- A list item consisting of exactly one `[label](#slot)` is a **response**: an edge to every node in that slot. It is removed from the card body and drawn as an edge label. Links inside prose stay links.
- A response to a slot that has no nodes is an error.
- Roots are nodes whose slot has no incoming edge. The graph may have several roots, rejoin and cycle.
- A node unreachable from every root is an error.

## Labels
- A line `[name]: <oklch(L C H)> "description"` outside any section defines a label: a link reference definition, so it renders as nothing elsewhere. `name` is `[\w-]+`; the description is optional.
- `.name` in a heading's `{…}` attaches the label. Labels annotate only: they change neither id, slot nor visibility.
- Defining a label twice, attaching an undefined one, or attaching one twice is an error.

## Languages
- Inside a section, a line `<div lang="code">` opens a language scope and the next `</div>` line closes it; `code` is `[\w-]+`. Both lines are removed from the card body. The md renders as plain html divs elsewhere.
- Body lines and responses inside the scope belong to that language; everything outside it belongs to every language.
- A heading inside the scope is the card's title in that language. It starts no node: slot, tags and labels come from the main heading alone. A second title for one language in a section, or a `{…}` block on it, is an error.
- Languages are the union of the scopes' codes, in order of first appearance; nothing is declared.
- A scope inside another, or one never closed, is an error.

## Marks
- A line `[dim=value]: #` or `[lang="code"]: #` outside any section marks a chosen variant value, or the chosen language: a link reference definition, so it renders as nothing elsewhere.
- A page with no selection of its own starts from the marks.
- A second mark for one dim (or a second language mark), a dim no heading tags, a value no heading gives it, or a language with no scope, is an error.

## Saving
Ctrl+S and Save ▾ .html / .md write the md as it is, except:
- If it has marks, they follow the current selection: a changed one is rewritten in place, one for a dim no longer chosen is dropped, new ones go after the last mark. Save ▾ selection adds the marks after the labels, or removes them all.
- If anything precedes the first heading, a `---` line follows it, unless the last such line already is one.

## Editing
- An edit whose result has errors is refused.
- Deleting a card removes its section. If it was the last node of its slot, the responses into that slot go with it.
- Renaming or deleting a label rewrites every heading carrying it.
- Undo (`u`, Ctrl+Z) and redo (`U`, Ctrl+Y, Ctrl+Shift+Z) step through this page's edits; the history lives in page memory, not the md.
- Dragging a card's handle onto another card adds the response `- [TODO](#slot)` into that card's slot, after the dragged card's last response outside a language scope, or at the end of its section if it has none.

## Selection
`{ variants: {dim → value}, lang, path: [nodeId], calling: bool }`, kept in `sessionStorage`; a new tab starts from the md's marks. A dim without a value is not chosen yet and admits every variant.

- A node is **visible** iff it is reachable from a root through nodes whose tags all agree with the chosen variants, along responses in the chosen language.
- Cards show only the chosen language's lines. Unlike variants, a language is always chosen while the document has any.
- After every reparse, path entries and variant values absent from the document are dropped; an absent language becomes the document's first.
- Clicking a card or edge label appends it to the path; a variant-tagged card also chooses its tags.
- New call (`n`) empties the path and starts calling; Clear (Esc while not editing) empties the path and stops calling.
- While calling, every click scrolls its card and the cards it leads to into view at once.
- Backspace deletes the current card.

## Embedding
The markdown is embedded in a `<script>` block, so it must not contain `<script` or `</script` (any case).
