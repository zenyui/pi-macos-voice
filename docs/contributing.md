# Contributing

## Build from source

```sh
git clone git@github.com:zenyui/picrophone.git
cd picrophone
npm install        # dev types only; runtime deps come from pi
npm run build      # gen-version → per-arch swift build → lipo → sign → assemble Picrophone.app
npm run clean      # remove build artifacts
```

Requires the Xcode command-line tools (`xcode-select --install`). The build
produces a **universal** (arm64 + x86_64) binary by compiling each arch
separately and merging them with `lipo` — this works with the Command Line
Tools alone (the combined `--arch a --arch b` invocation would need full Xcode).

Load the local copy without installing the package. `-ne` disables installed
extensions so an installed `picrophone` package doesn't clash with the checkout:

```sh
pi -ne -e ./extension/index.ts
```

The committed universal `picrophone` binary and `Picrophone.app` live in
`packages/picrophone-darwin/bin`, so a fresh checkout runs without building on
any Mac. The extension resolves the binary from the installed platform package
(`picrophone-<platform>`) and falls back to `packages/picrophone-<platform>/bin`
in a checkout.

## Package layout

- `picrophone` (root) — the JS extension + assets. Ships no binary.
- `picrophone-darwin` — macOS universal binary + app, gated by npm on `os`/`cpu`.
- `picrophone-win32` — Windows placeholder (no binary yet).

The root package lists the platform packages as `optionalDependencies`, so npm
installs only the one matching the user's machine and silently skips the rest.

## Releasing

All packages are versioned in **lockstep** — bump `version` in all three
`package.json` files and the `optionalDependencies` pins to the same value, then
`npm run build` so the binary reports the new version.

```sh
npm run build          # rebuild the universal binary at the new version
npm run publish:all    # publishes picrophone-darwin, then picrophone
```

`publish:all` guards that the darwin binary is universal before publishing.
`picrophone-win32` is intentionally skipped until a real Windows binary exists —
as an optionalDependency, npm ignores it not being on the registry.

Updating the README on npm (and the [pi.dev gallery](https://pi.dev/packages))
requires publishing a new version — npm renders the README from the latest
published tarball.

## Commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org).
Prefix commit subjects with a type, e.g.:

```
feat: add push-to-talk mode
fix: stop word not silencing readback
chore: bump dependencies
```

Common types: `feat`, `fix`, `chore`, `refactor`, `test`.
