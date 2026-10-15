# Vendored icon subset

Lucide Icons, revision `70562c1ee1c4fdcf736fe97bc893fb8511927934`.
Source: https://github.com/lucide-icons/lucide/tree/70562c1ee1c4fdcf736fe97bc893fb8511927934/icons

The selected SVG geometries in `src/ui/icons.ts` and `src/ui/icon-set.ts` (including
`puzzle`, `route` and `split`) are unmodified. Rendering uses AGH's 24px view box,
currentColor and 1.5px rounded stroke. No runtime dependency.
Names follow upstream, with `history` mapped to `rotate-ccw` and `trash-2` to `trash`.
Lucide is ISC; Feather-derived geometries also retain the upstream MIT notice.
The complete upstream license is in [LUCIDE-LICENSE](LUCIDE-LICENSE).

## Terminal renderer

`@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 are MIT-licensed runtime dependencies from
https://github.com/xtermjs/xterm.js. Their original LICENSE files are retained in the installed
packages and copied by both Web build pipelines to `web/THIRD-PARTY-NOTICES/xterm-xterm.txt`
and `web/THIRD-PARTY-NOTICES/xterm-addon-fit.txt`. The terminal screen is loaded on demand.
See [runtime dependency provenance](../../third-party/runtime-dependencies.json).
