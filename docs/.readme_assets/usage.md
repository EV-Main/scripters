```sh
call_scripters build script.md   # writes script.html
```
Open the html in any browser. Click cards or responses to follow the call, pick variants in the top bar, double-click a card to edit its markdown (Ctrl+Enter commits, Esc cancels), Ctrl+S saves the edited file. Format: [docs/spec/script_format.md](docs/spec/script_format.md).

`nix run` builds the demo (or `nix run . -- script.md`) into a temp file and opens it with `xdg-open`.
