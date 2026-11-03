```sh
call_scripters build script.md --direction horizontal   # or vertical; writes script.html
```
Open the html in any browser. Click cards or responses to follow the call, pick variants and layout spacing in the top bar, double-click a card to edit its markdown (Ctrl+Enter commits, Esc cancels; Esc outside an edit starts a new call), Ctrl+S saves the edited file. Format: [docs/spec/script_format.md](docs/spec/script_format.md).

`nix run . -- <horizontal|vertical> [script.md]` builds the script (the demo by default) into a temp file and opens it with `xdg-open`.
