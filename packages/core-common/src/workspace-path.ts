// Lexical path normalization: it folds `.` and `..`, unifies separators, and reports whether the
// result lands inside the workspace. It never touches the filesystem, so it cannot see through a
// symlink — a link inside the workspace pointing out of it still reports `inside: true`. Confining
// what a tool may actually open is the job of the sandbox and the filesystem adapter behind
// `ToolContext.fs`; this function answers the narrower question of what a path *spells*, which is
// what path-shaped policy matching and change tracking need.
//
// The one hard rule: `inside: true` must never be returned for a path that spells its way out of
// the workspace. `false` is the conservative answer — a caller treats such a path as foreign — so
// where the lexical answer is uncertain (a case-variant segment on a case-insensitive filesystem)
// this returns `false`.
//
// `inside` is NOT an authorization decision, and no caller may use it as one. It is lexical only:
// a symlink inside the workspace pointing out of it reports `inside: true`, and opening the `abs`
// that comes back then reads a file outside the workspace. Closing that gap takes a filesystem
// operation — resolving through `realpath`, or opening with `RESOLVE_BENEATH` / `O_NOFOLLOW` and
// re-running the containment check on the resolved path — which belongs in the `fs` seam and the
// sandbox, not here.
//
// Never apply Unicode compatibility normalization (NFKC / NFKD) to a path after this check. Seven
// spellings — U+FF0E, U+2024, U+2025, U+FE52, U+FF0F, U+2215, U+0338 — collapse to `.` or `/` under
// NFKC but not under NFC/NFD. No filesystem applies compatibility normalization, so this function
// keeps them as ordinary segment names and reports them inside, which is correct; normalizing
// afterwards would turn one of those names back into a traversal that has already been cleared.

// `rel` is containment-sound but NOT canonical: it is not an identity, and it is not usable as a
// cache key without further canonicalization. Two arguments are often confused here — folding a
// spelling can only move a path towards `inside: false`, which makes the *containment* answer safe,
// while saying nothing about whether two inputs that produce one `rel` name one file. They need not:
// where a backslash is an ordinary filename character, `src\a.ts` is a single file whose name
// contains a backslash, and it yields the same `rel` as the file `a.ts` inside the directory `src`.
// Nor is `rel` a fixed point — a first segment that parses as a drive survives into it (`./C:` gives
// `rel: 'C:'`), and feeding that `rel` back through this function lands elsewhere entirely, outside
// the workspace. A consumer that hashes `rel` into a key and caches a decision under it would let
// one decision cover a file that was never decided about. Such a consumer must canonicalize first —
// refuse an input containing a backslash or whose first segment matches `^[A-Za-z]:`, or key on the
// containment-checked `abs` instead.

export type NormalizedPath = { rel: string; abs: string; inside: boolean }

// A drive prefix (`C:`) is the only root spelling that is not a leading separator. It is kept apart
// from the segments rather than treated as the first one so that a drive-rooted workspace can be
// compared against drive-rooted inputs, and so a drive path can never prefix-match a
// separator-rooted root. It does not by itself make a usable workspace root — see below.
const DRIVE = /^([A-Za-z]):(.*)$/s

type Rooted = { drive: string; segs: string[] }

// `input` has already been through split(), so its separators are all '/'.
function fold(base: string[], input: string): string[] {
  const out = [...base]
  for (const s of input.split('/')) {
    // A segment is classified by what precedes any NUL in it. The string itself is kept whole, but
    // an interface that stops at a NUL — a sandbox helper binary, anything below the C boundary —
    // sees only that prefix, so `..\0x` reaches it as `..`. Folding the truncated form here is what
    // stops the two readings of the same string from disagreeing about where it points.
    const nul = s.indexOf('\0')
    const seg = nul === -1 ? s : s.slice(0, nul)
    if (seg === '' || seg === '.') continue
    // Popping an empty stack is a no-op, so `..` past the root clamps at the root instead of
    // underflowing and letting later segments reattach below the workspace.
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(s)
  }
  return out
}

// Both separators are folded, on every platform. This function is asked about paths that came from
// a model or a config file, not about the host it happens to run on, and a backslash traversal must
// not survive just because the process runs on a system that would treat a backslash as an ordinary
// character. Treating one as a separator can only move a path towards `inside: false` — a statement
// about *containment*, and not about identity: see the note on `rel` above.
function split(p: string): { drive: string; rest: string; absolute: boolean } {
  const norm = p.replace(/\\/g, '/')
  const m = DRIVE.exec(norm)
  // Drive letters are case-insensitive wherever drives exist at all, so `c:` and `C:` name the same
  // root. Path segments are left alone: lowercasing them would report a case-variant path as inside
  // the workspace on a case-sensitive filesystem, where it is a different file.
  // `C:foo` (drive-relative) counts as absolute too — it is rooted on the drive, not on this
  // workspace, and resolving it against the workspace root would invent a location.
  if (m) return { drive: `${(m[1] as string).toUpperCase()}:`, rest: m[2] as string, absolute: true }
  return { drive: '', rest: norm, absolute: norm.startsWith('/') }
}

function render(root: Rooted): string {
  return `${root.drive}/${root.segs.join('/')}`
}

export function normalizeWorkspacePath(input: string, workspaceRoot: string): NormalizedPath {
  const rootParts = split(typeof workspaceRoot === 'string' ? workspaceRoot : '')
  const root: Rooted = { drive: rootParts.drive, segs: fold([], rootParts.rest) }
  // A root of '', '/' or '.' folds to zero segments, and the containment check below is then
  // vacuously true for every path on the machine — `/etc/passwd` included. A relative root would be
  // silently promoted to an absolute one naming a different directory. Both are refused rather than
  // answered wrongly: a guard that turns itself off when misconfigured is worse than no guard,
  // because its callers believe it is on.
  // A drive root is held to the same rule: 'C:/' has zero segments and would make every path on
  // that drive inside, and 'C:.' / 'C:..' name no directory at all. Naming one drive is not
  // narrower than naming one machine by enough to be worth a carve-out.
  //
  // This throw stays even once a root is also validated where the workspace is assembled. The two
  // are not alternatives: the whole argument for checking here is that this function cannot trust
  // its caller to have checked, so validation at assembly time is a better first line rather than a
  // replacement. It must never be wrapped in a `catch` that swallows it and carries on — that is
  // the one way back to the vacuous `inside: true` the refusal exists to prevent.
  if (!rootParts.absolute || root.segs.length === 0)
    throw new Error(
      `workspaceRoot must be an absolute path with at least one segment: ${JSON.stringify(workspaceRoot)}`,
    )
  const parts = split(input)
  // A relative input is folded *together with* the root, in one pass, so a leading `..` pops a root
  // segment. Folding the input on its own first would silently turn `../secret` into `secret` and
  // report a file outside the workspace as one of its own.
  const target: Rooted = parts.absolute
    ? { drive: parts.drive, segs: fold([], parts.rest) }
    : { drive: root.drive, segs: fold(root.segs, parts.rest) }
  const abs = render(target)
  const inside =
    target.drive === root.drive &&
    target.segs.length >= root.segs.length &&
    // Segment-wise comparison, not a string prefix: `/work/proj-evil` starts with `/work/proj` as a
    // string but is a different directory.
    root.segs.every((s, i) => target.segs[i] === s)
  if (!inside) return { rel: abs, abs, inside: false }
  const rel = target.segs.slice(root.segs.length).join('/')
  return { rel: rel === '' ? '.' : rel, abs, inside: true }
}
