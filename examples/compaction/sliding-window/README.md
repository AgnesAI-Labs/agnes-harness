# Sliding-window compaction engine

An independent package using public AGH exports. Keep the last `keepTurns` turns (default four), fixed system context and pinned conversation nodes. This engine intentionally elides old facts without a model call; Core preserves their ledger records and validates the replacement.

With matching published SDK packages, run `npm install`, `npm run build`, and `npm test` here. In the source preview, build SDK declarations, copy this directory outside the checkout and run `node templates/link-local.mjs <copied-directory>` from the AGH root before those build/test commands. See the [author guide](../../../docs/extend/compaction-engines.md).

Install and enable `main` using AGH plugin management. The plugin row config accepts `{ "keepTurns": 2 }`. Select the registered engine in your runtime profile with `{ "compaction": { "engine": "sliding-window" } }` and reassemble Host. No provider or Core-private imports are required by this package.
