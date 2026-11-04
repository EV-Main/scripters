```sh
scripters build script.md --direction vertical   # or horizontal; writes /tmp/scripters/script.html (-o to override)
scripters watch script.md   # serves it on localhost and opens it; the page reloads on each save of the md, its Ctrl+S writes the md
```
Open the html in any browser. Click cards or responses to follow the call, pick variants and layout spacing in the top bar, zoom with − / + (`-`, `+` or `=`), Ctrl+scroll or a pinch, double-click a card to edit its markdown (Ctrl+Enter commits, Esc cancels), `n` starts a new call: the view jumps to each card you click until Clear (Esc outside an edit) ends the call and clears the walked path; `c` scrolls back to the start without touching the call; × or Backspace deletes the current card, Labels (`l`) in the top bar defines labels that cards carry. Ctrl+S overwrites the opened file (Chromium asks for it once; under `watch`, the md), Save ▾ (`s`) downloads a copy as .html or .md; hovering a bar control shows its hint and keys; ☾/☀ switches theme. Format: [docs/spec/script_format.md](docs/spec/script_format.md).

`nix run . -- [script.md] [--direction horizontal]` watches the script (the demo by default).
