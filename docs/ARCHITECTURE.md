# Architecture
```
script.md ──(cargo r -- build)──► script.html
                                   ├─ <script type="text/markdown" id="src"> raw md </script>
                                   ├─ inlined css, vendor/marked, vendor/dagre, model.js, view.js
                                   └─ at runtime: md ─parse─► graph ─filter(selection)─► dagre layout ─► cards + svg edges
edit card ─► splice section text into md string ─► reparse ─► rerender
save      ─► same html with the #src block replaced   (download .html / .md)
```

- `src/main.rs`: bundler only. Fills `web/template.html` placeholders with `web/` files and the markdown.
- `web/model.js`: pure `parse(md)` and `visible(graph, selection)`. No DOM; also loaded by `node --test web/`.
- `web/view.js`: rendering, layout, interaction, inline editing, session storage, saving.
- `web/vendor/`: `marked`, `@dagrejs/dagre`; version and source on each file's first line.

Format and semantics: [spec/script_format.md](spec/script_format.md).

## Invariants
1. The output is a single file that works offline on `file://`: no server, no CDN, no external references.
2. The embedded markdown is the only source of truth. Edits splice into it and reparse; there is no graph→md serializer.
3. `web/model.js` is the only parser of the format. Rust bundles and never parses.
