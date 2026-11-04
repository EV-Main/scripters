# Architecture
A call script is a markdown file; the caller follows it as a clickable conversation graph in one offline html file, and edits it in place.

```
script.call.md ──bundle──► script.html (md embedded verbatim + inlined web/ assets)
                              └─ runtime: md ─parse─► graph ─filter(selection)─► layout ─► cards + edges
any edit ─► splice into md ─► reparse ─► rerender
save     ─► same html with the embedded md replaced

watch: script.call.md ─bundle per request─► http://127.0.0.1 page ─poll /version─► reload
       page Ctrl+S ─PUT md─► script.call.md   (refused if it changed since the page loaded)
```

- `src/`: the bundler, and the `watch` server.
- `web/model.js`: the format's parser and visibility rules; DOM-free.
- `web/place.js`: cross-axis placement of dagre's layout (Graphviz dot's network-simplex pass); DOM-free.
- `web/view.js`: everything the page does.

Format and semantics: [spec/script_format.md](spec/script_format.md).

## Invariants
1. The output is a single file that works offline on `file://`: no server, no CDN, no external references. `watch` serves that same file, marked `data-live`; nothing in the page depends on being served.
2. The embedded markdown is the only source of truth. Edits splice into it and reparse; there is no graph→md serializer.
3. `web/model.js` is the only parser of the format. Rust bundles and never parses.
