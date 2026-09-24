# jiti 2.7.0 loader contract patch

The host loader needs fresh extension module graphs while retaining the host's three shared
module instances. Upstream `moduleCache:false` only controls its runtime/CommonJS cache;
native ESM evaluation can retain both old code and dependencies outside `virtualModules`.
Forcing only the entry does not fix nested ESM modules.

This pinned pnpm patch adds an opt-in `forceTranspile` option and changes two runtime expressions:

1. `evalOptions.forceTranspile` still has priority. Otherwise `ctx.opts.forceTranspile` is consulted
   before upstream syntax-based native/transformed selection. Nested evaluators already inherit
   `ctx.opts`, so JS, TS and CJS code stay on jiti's module graph and virtual imports.
2. JSON imports clear that resolved entry from the native require cache before reading only when
   `forceTranspile` is enabled and `moduleCache` is false. Unmodified upstream behavior remains
   the default for other jiti consumers, including Vite.

The JSON eviction key comes from `nativeRequire.resolve`, not jiti's slash-normalized path.
On Windows those spellings differ: deleting the slash form leaves the real CommonJS cache entry
alive and reloads stale JSON. Resolve only the selected entry; never clear the whole cache.

The type declaration exposes the opt-in property. No native-module, built-in, filesystem, or
credential policy is widened. This is not a sandbox against trusted extensions deliberately
calling Node's own loaders. Source/bundled/SEA packaging acceptance remains in host Task19.

Upstream sources (MIT): [eval.ts](https://github.com/unjs/jiti/blob/v2.7.0/src/eval.ts) and
[require.ts](https://github.com/unjs/jiti/blob/v2.7.0/src/require.ts). The published runtime is one
minified line, hence the large generated patch despite two local expression changes. Rebuild with
`pnpm patch jiti@2.7.0`, apply those changes to `dist/jiti.cjs` and add the option to `lib/types.d.ts`,
then use `pnpm patch-commit`. Do not edit the installed pnpm store directly.

Before updating/removing this patch, run host `test/ext-host/loader.test.ts`, including real shared
namespace identity against decoy packages, nested JS/CJS/TS edits, and JSON edits, then all repository
gates. SEA and native addons need their own platform evidence; these unit tests do not provide it.
