import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchesRatchetKey } from './ratchet-key.js'
import { isTestFile, LITERAL_SCAN_EXCLUDE_DIRS, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * PATH-01 found two call sites computing a profile's dataDir differently: host's resolver defaulted
 * an unset dataDir to the home root itself, daemon's supervisor defaulted it to `home/data`. Neither
 * file knew the other existed; a machine that exercised both ended up with two parallel session
 * trees, and `agnes doctor`/`agnes stats` -- which hardcoded the same `join(home, 'data')` a third
 * way -- reported "no sessions.db yet" while looking at the wrong one. The fix (packages/host/src/
 * paths.ts) made dataDir()/cacheDir()/agnesHome() the one place in the repo that knows this layout.
 *
 * A fix that only migrates the call sites known at the time is not structural: nothing stops the next
 * new call site from writing `join(home, 'data')` again, because the fact that this literal pair
 * spells out a layout paths.ts already owns is not enforced anywhere -- it was only true by
 * convention, the same convention two files already broke once. This guard is what makes a second
 * convention have nowhere to come from: outside paths.ts, this repository refuses to let source
 * either (a) join a home-shaped path onto the literal segment 'data' or 'cache' -- the exact shape
 * dataDir()/cacheDir() exist to replace -- or (b) spell out the harness's own directory name, `.agh`
 * or the pre-rename `.agnes`, as a quoted path literal -- the values @agnes/protocol's AGH_DIR and
 * WORKSPACE_SECRET_DIRS exist to own. A caller that wants any of these values has to import it;
 * there is no other way to spell it that this guard lets through.
 */

// The one place in the repo allowed to contain either banned shape, because it *is* the shape: this
// module's whole job is to be the layout. Matched the same way kernel-create.test.ts blesses
// packages/host/src/assemble -- by path-boundary, not by name -- so a future split into a paths/
// directory (as assemble.ts was later split) stays exempt without editing this file.
const PATHS_MODULE_ABS = join(root, 'packages/host/src/paths')
// Rule B's one owner. The directory name lives in @agnes/protocol rather than paths.ts because it is
// needed by packages that cannot depend on @agnes/host (base, sdk, resource-control-worker, and
// sandbox-remote through core's re-export); protocol is the one layer all of them already sit above.
const NAMESPACE_MODULE_ABS = join(root, 'packages/protocol/src/constants')

const SCAN_DIRS = ['packages', 'tools'].map((d) => join(root, d))
const EXCLUDE_DIRS = LITERAL_SCAN_EXCLUDE_DIRS

// ── Rule A: join(<home-ish path>, 'data' | 'cache') ─────────────────────────────────────────────
//
// Whitespace-tolerant, including newlines, for the same reason KERNEL_CREATE_RE is in
// kernel-create.test.ts: `join(\n    home,\n    'cache',\n  )` is the same call as `join(home,
// 'cache')`, and a guard that only recognises the single-line spelling is trivially outrun by
// reformatting. Matched against the whole file text (not line by line) so the newline tolerance
// actually does something.
//
// Tolerates an optional trailing comma before the closing paren (`join(\n  home,\n  'cache',\n)`) --
// this repo's own formatter (biome) routinely adds one to a call broken across lines, and the first
// draft of this regex required the closing paren immediately after the literal, which meant a
// perfectly ordinary reformat of a two-line call would have silently stopped matching. Caught by the
// `it.each` cases below, which is exactly the point of writing them before trusting the regex.
//
// Known, deliberate blind spot -- registered and pinned in the describe block below, the same
// discipline platform.test.ts uses for its own aliasing gap: a first argument containing its own
// parentheses, e.g. `join(getHome(), 'data')`, does not match `[^,()]+`. Nothing in this repository
// spells the call that way today (every real site passes a plain identifier or property chain), and
// a call parser robust to arbitrary nesting is more machinery than this guard's actual job -- keeping
// someone from casually retyping `join(home, 'data')` -- justifies. If that ever changes, this is the
// place to widen the pattern, not to quietly accept the gap.
export const JOIN_DATA_CACHE_RE = /\bjoin\s*\(\s*[^,()]+\s*,\s*(['"])(?:data|cache)\1\s*,?\s*\)/g

// ── Rule B: the harness directory name as a quoted path literal ───────────────────────────────
//
// Matches a quoted string that is exactly `.agh` or `.agnes`, or starts with `.agh/` or `.agnes/` --
// `'.agh'`, `'.agh/hooks.json'`, `'.agnes/secrets'`. That is every spelling a call site would use to
// rebuild a path inside the harness's namespace, which is the thing that has to come from one place:
// the rename to `.agh` had to find such spellings in five packages, and any one of them left behind
// would have kept reading or writing the other product's `.agnes` directory without a sound.
//
// Deliberately still narrow in one direction: a name that merely *starts* with `.agnes` as a prefix
// (`.agnes-lock.lock`, `.agnes-package-audit.jsonl`, `.agnes-fetch-`) is a filename inside a profile
// or home directory that is already under the new root, not a reconstruction of the namespace, and
// does not match -- the character after the name has to be a `/` or the closing quote.
//
// Matches only real quotes ('/"), not backticks: prose in comments is written in backtick-flavoured
// Markdown (see paths.ts's own docstring), and prose is not a path construction. A template literal
// built from the constant, `${AGH_DIR}/hooks.json`, is exactly what this guard asks for.
//
// Known, deliberate blind spot -- registered and pinned below: a template literal that spells the
// name out after an interpolation, e.g. `` `${x}.agh` ``, is not a quote-delimited literal and would
// not match. No call site in the repo is written that way; if one appears, widen the pattern.
export const HARNESS_DIR_LITERAL_RE = /(['"])\.(?:agh|agnes)(?:\/[^'"\n]*)?\1/g

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

// ── Exemption mechanism ─────────────────────────────────────────────────────────────────────────
//
// This repo already has two precedents for granting a guard an exemption: an inline marker comment
// written in the *flagged* file (platform.test.ts's `// guards-allow-platform:`), and a companion
// JSON data file the guard reads and audits (secrets.test.ts's secrets-allowlist.json). Neither fits
// this guard well.
//
// The inline-marker style means a change can slip past this rule without ever touching
// tools/guards/ -- whoever writes the offending line also writes the comment that waives it, in the
// same commit, unreviewed by anything that understands why the rule exists. That is exactly backwards
// for a guard whose entire point is that individual call sites should not get to decide the layout for
// themselves.
//
// The JSON-file style is not unsafe in general -- secrets-allowlist.json's own auditFindings()
// enforces real invariants (a reason is required, production source files can never be allowlisted,
// stale entries go red) -- but it earns that safety by being large and open-ended: secrets findings
// turn up across a whole docs tree over time, so a data file with programmatic auditing is the right
// shape for that guard. This one is the opposite: a short, closed set of named exceptions -- none for
// Rule B, one further down for Rule A -- each decided in a single review for a specific, stated reason.
// Keeping that small list as literal TypeScript in this file, the way kernel-create.test.ts's
// ALLOWED_ABS does, means every future addition is a diff to the guard's own source -- reviewed with
// the same scrutiny as the rule it loosens, sitting right next to the paragraphs above that explain
// what the rule is for, and required by the type below to state a reason or fail to compile. That is
// harder to add to carelessly than either alternative, which is the property this exemption
// mechanism is chosen for.
//
// Each entry is pinned to the *exact* trimmed source line expected to carry the literal, not merely to
// a file path. A file-level exemption would let a second, unrelated literal ride through on the
// coattails of the first; pinning to the line means any new occurrence -- even one added to an
// already-exempted file -- has nothing to match and is still reported. If the pinned line ever changes
// even cosmetically, the exemption stops matching and this guard goes red, which is deliberate: a
// changed line is a reason to look again, not to keep waving the old line through.
type HarnessDirLiteralExemption = {
  readonly path: string
  readonly line: string
  readonly reason: string
}

// Empty, and pinned empty by a count test below. Before the `.agh` rename this list held six entries
// (session-workspace.ts, adapters/index.ts, profile/inputs.ts, default-journal.node.ts, discover.ts,
// skill-bootstrap.ts): workspace-relative `.agnes` paths that were not the home root, and two packages
// that could not import agnesHome() from @agnes/host. Every one of those lines now imports AGH_DIR or
// WORKSPACE_SECRET_DIRS from @agnes/protocol, which all of those packages can already depend on, so
// none of the reasons those entries gave still applies. Adding one back is a decision, not a side effect.
const HARNESS_DIR_LITERAL_EXEMPTIONS: readonly HarnessDirLiteralExemption[] = []

// Rule A's own exemption list, kept separate from Rule B's rather than merged into one shape: the two
// rules match different things (a call shape vs. a string literal) and a merged type would need an
// optional-or-union field to tell them apart, which is more confusing than two small parallel lists.
// Exactly one entry. It is not an architectural boundary at all -- it is the precise DRY gap PATH-01's own report named and chose not to migrate,
// re-verified here rather than taken on faith, with an attempted fix that ran into a wall this task
// cannot move. See the entry's `reason` for the full account.
type JoinDataCacheExemption = {
  readonly path: string
  readonly line: string
  readonly reason: string
}

const JOIN_DATA_CACHE_EXEMPTIONS: readonly JoinDataCacheExemption[] = [
  {
    path: 'packages/daemon/src/supervisor/scope.ts',
    line: "expandHome(inputs.user?.cacheDir ?? join(home, 'cache'), input.osHome),",
    reason:
      "join(home, 'cache') here computes byte-for-byte the value importing and calling cacheDir(home) " +
      'from @agnes/host would -- read both implementations side by side to confirm this, not assumed. ' +
      "PATH-01's own report named this exact line as a deliberate non-migration: the value is already " +
      "correct (unlike dataDir's two call sites, which actively disagreed), so this is a DRY gap, not " +
      'a live bug. This session tried to close it anyway. Migrating costs exactly one line: adding ' +
      "cacheDir to this file's existing @agnes/host import forces one new line, because that import " +
      "is already multi-line and biome's formatter always places one named import per line once a " +
      'block is multi-line (verified by attempting the one-line form and reading the exact diagnostic ' +
      "biome check produced). This file's own line-count ratchet has zero spare for that line: as " +
      'committed on main, tools/guards/ratchet.json caps this file at 215 and the file itself measures ' +
      '214, but a *different*, already in-flight, uncommitted change elsewhere in this working tree ' +
      'has independently tightened both the ratchet.json entry and its INITIAL_CEILING pin in ' +
      "tools/guards/src/ratchet.test.ts to 214 -- and INITIAL_CEILING's entire purpose is refusing to " +
      "let a ratchet.json entry rise again once recorded, which is exactly the 'raise the ceiling to " +
      "fit' move this migration would otherwise reach for. Raising either file here would both fight " +
      'a guard built to prevent that and risk colliding with a concurrent, uncommitted change this ' +
      'task was told to stay out of. No line elsewhere in the file could be freed without cosmetically ' +
      'restructuring already-reviewed code; comments do not even count toward the ratchet (see ' +
      'count-lines.ts), so trimming one would not have helped either. Left exactly as PATH-01 left ' +
      'it. Recommended follow-up: once the in-flight ratchet change lands, re-attempt this migration ' +
      'against whatever ceiling it leaves behind.',
  },
]

describe('the Agnes home directory layout is reconstructed in exactly one place', () => {
  it('scans a non-trivial number of source files', () => {
    const total = SCAN_DIRS.reduce((n, d) => n + listSourceFiles(d, { excludeDirs: EXCLUDE_DIRS }).length, 0)
    expect(total).toBeGreaterThan(100)
  })

  it("no join(<path>, 'data' | 'cache') outside packages/host/src/paths, unless named and reasoned above", () => {
    const offenders: string[] = []
    for (const scanDir of SCAN_DIRS) {
      for (const f of listSourceFiles(scanDir, { excludeDirs: EXCLUDE_DIRS })) {
        const rel = relative(root, f).split(sep).join('/')
        if (isTestFile(rel)) continue
        if (matchesRatchetKey(f, PATHS_MODULE_ABS)) continue
        const text = readFileSync(f, 'utf8')
        const lines = text.split('\n')
        for (const m of text.matchAll(JOIN_DATA_CACHE_RE)) {
          const lineNo = lineAt(text, m.index)
          const lineText = (lines[lineNo - 1] ?? '').trim()
          const exempt = JOIN_DATA_CACHE_EXEMPTIONS.some((e) => e.path === rel && e.line === lineText)
          if (!exempt) offenders.push(`${rel}:${lineNo}  ${m[0]}`)
        }
      }
    }
    expect(
      offenders,
      `a second convention for the data/cache layout: ${offenders.join('\n')}\n` +
        'import dataDir()/cacheDir() from @agnes/host instead of reconstructing the path, or add a ' +
        'named, reasoned exemption to JOIN_DATA_CACHE_EXEMPTIONS if that genuinely cannot be done.',
    ).toEqual([])
  })

  it("packages/host/src/paths still spells out 'data' and 'cache' exactly where expected", () => {
    // Pins the exempt module's own shape, the same way kernel-create.test.ts pins Kernel.create to
    // "zero or exactly one" rather than merely excluding the assemble directory from the count. An
    // exemption that only checks *where* a literal is, never *how many* are there, would not notice
    // paths.ts itself growing a second, redundant way to spell the same join inside its own file --
    // which would defeat the "exactly one place" property just as surely as a new call site elsewhere
    // would, only quietly, because the per-file exemption still says yes.
    const text = readFileSync(`${PATHS_MODULE_ABS}.ts`, 'utf8')
    const matches = [...text.matchAll(JOIN_DATA_CACHE_RE)]
    expect(
      matches.map((m) => m[0]),
      'expected exactly dataDir() and cacheDir()',
    ).toEqual(["join(home, 'data')", "join(home, 'cache')"])
  })

  it('no quoted .agh / .agnes path literal outside packages/protocol/src/constants, unless named and reasoned above', () => {
    const offenders: string[] = []
    for (const scanDir of SCAN_DIRS) {
      for (const f of listSourceFiles(scanDir, { excludeDirs: EXCLUDE_DIRS })) {
        const rel = relative(root, f).split(sep).join('/')
        if (isTestFile(rel)) continue
        if (matchesRatchetKey(f, NAMESPACE_MODULE_ABS)) continue
        const text = readFileSync(f, 'utf8')
        const lines = text.split('\n')
        for (const m of text.matchAll(HARNESS_DIR_LITERAL_RE)) {
          const lineNo = lineAt(text, m.index)
          const lineText = (lines[lineNo - 1] ?? '').trim()
          const exempt = HARNESS_DIR_LITERAL_EXEMPTIONS.some((e) => e.path === rel && e.line === lineText)
          if (!exempt) offenders.push(`${rel}:${lineNo}  ${lineText}`)
        }
      }
    }
    expect(
      offenders,
      `harness directory name spelled out as a path literal: ${offenders.join('\n')}\n` +
        'import AGH_DIR or WORKSPACE_SECRET_DIRS from @agnes/protocol instead, or add a named, reasoned ' +
        'exemption to HARNESS_DIR_LITERAL_EXEMPTIONS if that genuinely cannot be done.',
    ).toEqual([])
  })

  it('packages/protocol/src/constants spells out the harness directory names exactly where expected', () => {
    // The same "exactly one place" pin as the paths.ts check above: excluding the owner from the scan
    // must not let the owner itself grow a second spelling unnoticed.
    const text = readFileSync(`${NAMESPACE_MODULE_ABS}.ts`, 'utf8')
    expect([...text.matchAll(HARNESS_DIR_LITERAL_RE)].map((m) => m[0])).toEqual([
      "'.agh'",
      "'.agh/secrets'",
      "'.agnes/secrets'",
    ])
  })

  it('every HARNESS_DIR_LITERAL_EXEMPTIONS entry is still consumed by real source', () => {
    // An exemption that no longer matches anything is not protecting anything, and the discipline this
    // repo names in AGENTS.md ("an exception must be consumed") says a stale one must be removed.
    for (const entry of HARNESS_DIR_LITERAL_EXEMPTIONS) {
      const text = readFileSync(join(root, entry.path), 'utf8')
      const found = text.split('\n').some((l) => l.trim() === entry.line)
      expect(found, `${entry.path}: exempted line no longer present verbatim:\n${entry.line}`).toBe(true)
      // .match(), not .test(): the regex carries the /g flag, and .test() on a global regex advances its
      // own lastIndex as a side effect, making each iteration depend on the previous one.
      expect(
        entry.line.match(HARNESS_DIR_LITERAL_RE),
        `${entry.path}: no literal left:\n${entry.line}`,
      ).not.toBeNull()
      expect(entry.reason.trim().length, `${entry.path}: exemption has no reason`).toBeGreaterThan(20)
    }
  })

  it('HARNESS_DIR_LITERAL_EXEMPTIONS is empty', () => {
    // A count pin: a growing exemption list is exactly how this class of guard rots into decoration.
    expect(HARNESS_DIR_LITERAL_EXEMPTIONS.length).toBe(0)
  })

  it('every JOIN_DATA_CACHE_EXEMPTIONS entry is still consumed by real source', () => {
    // The same "an exception must be consumed" discipline as the HARNESS_DIR_LITERAL_EXEMPTIONS check above,
    // applied to Rule A's exemption list.
    for (const entry of JOIN_DATA_CACHE_EXEMPTIONS) {
      const abs = join(root, entry.path)
      const text = readFileSync(abs, 'utf8')
      const found = text.split('\n').some((l) => l.trim() === entry.line)
      expect(found, `${entry.path}: exempted line no longer present verbatim:\n${entry.line}`).toBe(true)
      // .match(), not .test(): see the identical note on the HARNESS_DIR_LITERAL_EXEMPTIONS check above --
      // JOIN_DATA_CACHE_RE carries the same /g flag and the same lastIndex hazard.
      expect(
        entry.line.match(JOIN_DATA_CACHE_RE),
        `${entry.path}: exempted line no longer contains the join(<path>, 'data'|'cache') shape:\n${entry.line}`,
      ).not.toBeNull()
    }
  })

  it('every JOIN_DATA_CACHE_EXEMPTIONS entry states a non-trivial reason', () => {
    for (const entry of JOIN_DATA_CACHE_EXEMPTIONS) {
      expect(entry.reason.trim().length, `${entry.path}: exemption has no reason`).toBeGreaterThan(20)
    }
  })

  it('exactly the one known JOIN_DATA_CACHE_EXEMPTIONS entry, no more, no fewer', () => {
    expect(JOIN_DATA_CACHE_EXEMPTIONS.length).toBe(1)
  })
})

// ── Direct regex tests: prove the shapes actually match / do not match ─────────────────────────────
//
// This repo's stated convention (tilde-path.test.ts, platform.test.ts) is that a guard is not trusted
// until it has been watched to fail on the shape it claims to catch. These are the permanent record of
// that: every real occurrence found in the tree before this guard was written is exercised here as a
// positive case, and the near-miss spellings that must keep passing are exercised as negative cases,
// so a future change to either regex cannot silently narrow or widen it without a test noticing.
describe('JOIN_DATA_CACHE_RE matches the data/cache join shape, tolerating whitespace and quote style', () => {
  it.each([
    ["join(home, 'data')", "join(home, 'data')"],
    ['join(home, "cache")', 'join(home, "cache")'],
    ["join( home , 'cache' )", "join( home , 'cache' )"],
    ["join(\n    home,\n    'cache',\n  )", "join(\n    home,\n    'cache',\n  )"],
    ["expandHome(inputs.user?.cacheDir ?? join(home, 'cache'), input.osHome)", "join(home, 'cache')"],
    ['join(opts.home, "data")', 'join(opts.home, "data")'],
  ])('matches in %j', (src, expected) => {
    const m = src.match(JOIN_DATA_CACHE_RE)
    expect(m).not.toBeNull()
    expect(m?.[0]).toBe(expected)
  })

  it.each([
    ["join(dataDir, 'sessions.db')"],
    ["join(home, 'profiles')"],
    ["join(home, 'data-export')"],
    ['dataDir(home)'],
    ["join(home, 'Data')"],
    ['join(home, cacheDir)'],
  ])('does not match %j', (src) => {
    expect(src.match(JOIN_DATA_CACHE_RE)).toBeNull()
  })
})

describe('HARNESS_DIR_LITERAL_RE matches a quoted .agh / .agnes path literal and nothing looser', () => {
  it.each([
    ["'.agh'", "'.agh'"],
    ['".agh"', '".agh"'],
    ["'.agnes'", "'.agnes'"],
    ["join(home, '.agh')", "'.agh'"],
    ["join(homedir(), '.agnes', 'sdk')", "'.agnes'"],
    ["const HOOKS_PATH = '.agnes/hooks.json'", "'.agnes/hooks.json'"],
    ["below(workspaceRoot, '.agh/secrets', 'host integrity path')", "'.agh/secrets'"],
  ])('matches in %j', (src, expected) => {
    const m = src.match(HARNESS_DIR_LITERAL_RE)
    expect(m).not.toBeNull()
    expect(m?.[0]).toBe(expected)
  })

  it.each([
    ["'.agnes-fetch-'"],
    ["'.agnes-package-transaction.json'"],
    ["'.agnes-tmp'"],
    ["'.aghx'"],
    ['`~/.agh`'],
    // Split so biome does not read the test input as a forgotten template (see the blind-spot note below).
    ['`' + '$' + '{AGH_DIR}/hooks.json`'],
    ["'agnesVersion'"],
    ['x.agnesVersion'],
    ["'not.agnes.either'"],
    ["'~/.agh/skills'"],
  ])('does not match %j', (src) => {
    expect(src.match(HARNESS_DIR_LITERAL_RE)).toBeNull()
  })
})

// ── A known blind spot in each regex, registered and pinned ────────────────────────────────────────
//
// Same discipline as platform.test.ts's own aliasing gap: a limitation that is acknowledged and tested
// is a decision; a limitation nobody wrote down is a bug waiting to be rediscovered. Inverted on
// purpose -- if either gap is ever really closed, one of these goes red and forces whoever closed it to
// notice and delete the registration, rather than leaving a stale "known limitation" comment forever.
describe('known blind spots in the path-layout guard (registered and pinned)', () => {
  it('JOIN_DATA_CACHE_RE misses a first argument that is itself a call, e.g. join(getHome(), "data")', () => {
    expect("join(getHome(), 'data')".match(JOIN_DATA_CACHE_RE)).toBeNull()
  })

  it('HARNESS_DIR_LITERAL_RE misses a template-literal spelling of .agh with a real interpolation', () => {
    // Assembled from pieces, none of which contain the two characters "$" and "{" next to each
    // other, rather than written as one '...${x}.agnes...' literal: the text below represents what
    // such a template literal would look like *in the file being scanned*, not an interpolation in
    // this file, and biome's noTemplateCurlyInString rule (rightly) cannot tell those apart from
    // inside a plain string -- it reads a literal `${x}` as a forgotten template. Splitting the "$"
    // from the "{" sidesteps the question instead of suppressing the rule, and the assembled value is
    // still exactly the bytes under test.
    const templateLiteralSpelling = '`' + '$' + '{x}.agh`'
    expect(templateLiteralSpelling.match(HARNESS_DIR_LITERAL_RE)).toBeNull()
  })

  it('but every direct spelling above is still caught, so the two gaps above are not the whole regex set failing (zombie-guard check)', () => {
    expect("join(home, 'data')".match(JOIN_DATA_CACHE_RE)).not.toBeNull()
    expect("'.agh'".match(HARNESS_DIR_LITERAL_RE)).not.toBeNull()
  })
})
