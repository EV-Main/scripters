```sh
scripters build script.scr.md --direction vertical   # or horizontal; writes /tmp/scripters/script.html (-o to override); -l dfs ranks each card below its latest caller instead of its earliest
scripters watch script.scr.md   # serves it on localhost and opens it; the page reloads on each save of the md, its Ctrl+S writes the md
```
Open the html in any browser. Click cards or responses to follow the call, pick variants and layout spacing in the top bar, zoom with − / + (`-`, `+` or `=`), Ctrl+scroll or a pinch, double-click a card to edit its markdown (Ctrl+Enter commits, Esc cancels), `n` starts a new call: the view jumps to each card you click until Clear (Esc outside an edit) ends the call and clears the walked path; `c` scrolls back to the start without touching the call; × or Backspace deletes the current card, Labels (`l`) in the top bar defines labels that cards carry. Ctrl+S overwrites the opened file (Chromium asks for it once; under `watch`, the md), Export ▾ (`e`) downloads a copy as .html or .scr.md; hovering a bar control shows its hint and keys; ☾/☀ switches theme. Format: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#format).

`nix run . -- [script.scr.md] [--direction horizontal]` watches the script (the demo by default).
