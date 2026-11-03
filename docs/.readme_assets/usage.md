```sh
call_scripters build script.md --direction vertical   # or horizontal; writes script.html
```
Open the html in any browser. Click cards or responses to follow the call, pick variants and layout spacing in the top bar, double-click a card to edit its markdown (Ctrl+Enter commits, Esc cancels; Esc outside an edit clears the walked path), `n` starts a new call, × or Backspace deletes the current card, Labels (`l`) in the top bar defines labels that cards carry. Ctrl+S overwrites the opened file (Chromium asks for it once), Save ▾ (`s`) downloads a copy as .html or .md; hovering a bar control shows its hint and key; ☾/☀ switches theme. Format: [docs/spec/script_format.md](docs/spec/script_format.md).

`nix run . -- [script.md] [--direction horizontal]` builds the script (the demo by default) into a temp file and opens it with `xdg-open`.
