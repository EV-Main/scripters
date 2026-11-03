# Architecture
A call script is a markdown file; the caller follows it as a clickable conversation graph in one offline html file, and edits it in place.

```
script.md ──bundle──► script.html (md embedded verbatim + inlined web/ assets)
                         └─ runtime: md ─parse─► graph ─filter(selection)─► layout ─► cards + edges
any edit ─► splice into md ─► reparse ─► rerender
save     ─► same html with the embedded md replaced
```

- `src/`: the bundler.
- `web/model.js`: the format's parser and visibility rules; DOM-free.
- `web/view.js`: everything the page does.

Format and semantics: [spec/script_format.md](spec/script_format.md).

## Invariants
1. The output is a single file that works offline on `file://`: no server, no CDN, no external references.
2. The embedded markdown is the only source of truth. Edits splice into it and reparse; there is no graph→md serializer.
3. `web/model.js` is the only parser of the format. Rust bundles and never parses.
