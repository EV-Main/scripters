{
  nixConfig = {
    extra-substituters = [ "https://valeratrades.cachix.org" ];
    extra-trusted-public-keys = [ "valeratrades.cachix.org-1:gXVwhzO5YB+BaiEJYT48qZgzdaErGQew6xtZcz4Fo1Q=" ];
  };

  inputs = {
    v_flakes.url = "github:valeratrades/v_flakes?ref=v1.6";
  };

  outputs = { self, v_flakes }:
    let
      inherit (v_flakes) flake-utils pre-commit-hooks;
      manifest = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).package;
      pname = manifest.name;
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import v_flakes.default_nixpkgs { inherit system; };
        rust = v_flakes.rs.default_nightly system;
        preCommit = v_flakes.files.preCommit { inherit pkgs; };
        # fills each `<!-- embed path -->` … `<!-- /embed -->` block with the md at `path`, relative to the embedding md, as a quote
        md-embed = pkgs.writeShellApplication {
          name = "md-embed";
          runtimeInputs = [ pkgs.gawk pkgs.git ];
          text = ''
            git grep -l '^<!-- embed ' -- '*.md' | while read -r md; do
              gawk -v dir="$(dirname "$md")" '
                /^<!-- \/embed -->$/ { inside = 0 }
                inside { next }
                { print }
                /^<!-- embed .+ -->$/ {
                  path = substr($0, 12, length($0) - 15)
                  print "> [" path "](" path ")"
                  first = 1
                  while ((got = (getline line < (dir "/" path))) > 0) {
                    if (first && line ~ /^# /) { first = 0; continue } # the link above titles it
                    first = 0
                    print (line == "" ? ">" : "> " line)
                  }
                  if (got < 0) { print FILENAME ": no " dir "/" path > "/dev/stderr"; exit 1 }
                  close(dir "/" path)
                  inside = 1
                }
                END { if (inside) { print FILENAME ": <!-- embed --> never closed" > "/dev/stderr"; exit 1 } }
              ' "$md" > "$md.embedded" || { rm "$md.embedded"; exit 1; }
              mv "$md.embedded" "$md"
              git add "$md"
            done
          '';
        };
        pre-commit-check = pre-commit-hooks.lib.${system}.run (preCommit // {
          hooks = preCommit.hooks // {
            md-embed = {
              enable = true;
              name = "md embeds";
              files = "\\.md$";
              pass_filenames = false;
              entry = pkgs.lib.getExe md-embed;
            };
          };
        });
        stdenv = if pkgs.stdenv.hostPlatform.isLinux then pkgs.stdenvAdapters.useMoldLinker pkgs.stdenv else pkgs.stdenv;

        rs = v_flakes.rs { inherit pkgs rust; };
        github = v_flakes.github {
          inherit pkgs pname rs;
          enable = true;
          lastSupportedVersion = "nightly-2026-11-02";
          jobs.default = true;
          release.targets = [ "x86_64-unknown-linux-gnu" "aarch64-apple-darwin" ];
          publishCachix = { name = "valeratrades"; systems = [ "x86_64-linux" "aarch64-darwin" ]; };
        };
        readme = v_flakes.readme-fw {
          inherit pkgs pname;
          defaults = true;
          lastSupportedVersion = "nightly-1.100";
          rootDir = ./.;
          badges = [ "msrv" "crates_io" "docs_rs" "loc" "ci" ];
        };
        combined = v_flakes.utils.combine { inherit rust; modules = [ rs github readme ]; };
      in
      {
        packages =
          let
            build_rust = v_flakes.rs.build_nightly system;
            rustc = build_rust;
            cargo = build_rust;
            rustPlatform = pkgs.makeRustPlatform {
              inherit rustc cargo stdenv;
            };
          in
          {
            default = rustPlatform.buildRustPackage {
              inherit pname;
              version = manifest.version;

              RUSTC_WRAPPER = ""; # .cargo/config.toml sets sccache, absent in the sandbox

              cargoLock.lockFile = ./Cargo.lock;
              src = pkgs.lib.cleanSource ./.;
            };
          };

        apps.default = {
          type = "app";
          meta.description = "[script.scr.md] [watch flags]: watch (the demo by default)";
          # cargo from PATH on the working tree, so it shares target/ with `cargo run`
          program = "${pkgs.writeShellScript "open-script" ''
            set -e
            root=$(git rev-parse --show-toplevel)
            md=''${1:-$root/examples/demo.scr.md}
            exec cargo run -q --manifest-path "$root/Cargo.toml" -- watch "$md" "''${@:2}"
          ''}";
        };

        apps.film = {
          type = "app";
          meta.description = "Redraw the README's walkthrough of the demo";
          program = "${pkgs.writeShellScript "film" ''
            set -e
            export PATH=${pkgs.lib.makeBinPath [ pkgs.chromium pkgs.libwebp pkgs.nodejs ]}:$PATH
            export FONTCONFIG_FILE=${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }}
            root=$(git rev-parse --show-toplevel)
            html=$(mktemp -d)/demo.html
            cargo run -q --manifest-path "$root/Cargo.toml" -- build "$root/examples/demo.scr.md" -o "$html"
            node "$root/examples/film.mjs" "$html" "''${1:-$root/docs/.readme_assets/assets/walkthrough.webp}"
          ''}";
        };

        devShells.default =
          with pkgs;
          mkShell {
            inherit stdenv;
            shellHook =
              pre-commit-check.shellHook
              + combined.shellHook
              + ''
                cp -f ${(v_flakes.files.treefmt) { inherit pkgs; }} ./.treefmt.toml
              '';

            packages = [
              mold
              openssl
              pkg-config
              rust
              nodejs
            ] ++ pre-commit-check.enabledPackages ++ combined.enabledPackages;

            env.RUST_BACKTRACE = 1;
            env.RUST_LIB_BACKTRACE = 0;
          };
      }
    );
}
