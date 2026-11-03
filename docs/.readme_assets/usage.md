```sh
call_scripters script.md --direction vertical   # or horizontal; writes script.html
```
Open the html in any browser. Click cards or responses to follow the call, pick variants and layout spacing in the top bar, zoom with − / + (`-`, `+`), Ctrl+scroll or a pinch, double-click a card to edit its markdown (Ctrl+Enter commits, Esc cancels), `n` starts a new call: the view jumps to each card you click until Clear (Esc outside an edit) ends the call and clears the walked path; × or Backspace deletes the current card, Labels (`l`) in the top bar defines labels that cards carry. Ctrl+S overwrites the opened file (Chromium asks for it once), Save ▾ (`s`) downloads a copy as .html or .md; hovering a bar control shows its hint and key; ☾/☀ switches theme. Format: [docs/spec/script_format.md](docs/spec/script_format.md).

`nix run . -- [script.md] [--direction horizontal]` builds the script (the demo by default) into a temp file and opens it with `xdg-open`.
