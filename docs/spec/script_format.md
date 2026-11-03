# Script format
```md
[hot]: <oklch(0.62 0.19 25)> "Ready to buy"

# Introduction {.hot}
Hi, this is **Sam** from …

- [Has time](#discovery)
- [Busy](#schedule-callback)

# Opening {opener=warm}
…
```

## Nodes
- Each `# ` (h1) heading outside a code fence starts a node. Its source span runs to the next such heading.
- Non-blank text before the first heading, other than label definitions, is an error.
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
- A line `[name]: <oklch(L C H)> "description"` before the first heading defines a label: a link reference definition, so it renders as nothing elsewhere. `name` is `[\w-]+`; the description is optional.
- `.name` in a heading's `{…}` attaches the label. Labels annotate only: they change neither id, slot nor visibility.
- Defining a label twice, attaching an undefined one, or attaching one twice is an error.

## Editing
- Every edit splices the md and reparses; an edit whose result has errors is refused.
- Deleting a card removes its section. If it was the last node of its slot, the responses into that slot go with it.
- Renaming or deleting a label rewrites every heading carrying it.

## Selection
`{ variants: {dim → value}, path: [nodeId] }`, kept in `sessionStorage`. A dim without a value is not chosen yet and admits every variant.

- A node is **visible** iff it is reachable from a root through nodes whose tags all agree with the chosen variants.
- After every reparse, path entries and variant values absent from the document are dropped.
- Clicking a card or edge label appends it to the path; a variant-tagged card also chooses its tags.
- New call (`n`), or Esc while not editing, empties the path.
- Backspace deletes the current card.

## Embedding
The markdown is embedded in a `<script>` block, so it must not contain `<script` or `</script` (any case).
