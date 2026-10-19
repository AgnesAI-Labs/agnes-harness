# jev-loop

Optional agent loop (`agnes.jev@0.1.0`) in which TypeSafe Jev chooses each step and the conversation model is asked only to write, bind or review. Install it from Plugins, Market; it needs a Jev side-call route (see `docs/guide/jev-loop.md`).

The source of truth is `packages/loop-jev`. `index.mjs` here is generated from it and is not committed. Regenerate it with `pnpm --filter @agnes/package-manager build:jev-payload` (the CLI build does this too). The plugin row in `package.json` mirrors the one in `packages/loop-jev/package.json` without `default`, so installing the package enables it; a test keeps the two in sync.
