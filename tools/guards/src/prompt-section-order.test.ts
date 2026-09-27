import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * The canonical claim table for every model-visible prompt section, across at least three
 * mechanisms that can contribute one: @agnes/code's Operation.contribute (validated locally by
 * packages/code/src/prompts/sections.ts's own validateSections()); the 'context' hook
 * (packages/base/extensions/*'s escape hatch, which validateSections never sees because it sets
 * its order through a hook payload, not through that table); and packages/core's own hardcoded
 * orders (the untrusted-envelope rule section and the harness prompt/memory sections).
 * This file is the one place the first two are checked against each other: base cannot import
 * code's module (no dependency edge runs that direction — packages/base/package.json names no
 * @agnes/code dependency, and packages/code's @agnes/base entry is a devDependency, never bundled
 * at runtime), so the cross-check has to live above both, as a second, independent read of what
 * each package's source literally says.
 *
 * The 'core'-owned rows are fixed reserved values, not scanned claims: unlike the 'code' and
 * 'base' rows, nothing in this file re-reads packages/core's source to confirm they still say
 * what this table says they say. Core is trusted, in-tree source, not the failure mode this guard
 * polices (two independent contributors landing on the same order by accident) — but leaving its
 * orders out of the table entirely is what let this gap exist in the first place: a code or base
 * row could previously claim any of core's orders and pass every check here anyway. Listing them
 * closes that, since the no-duplicate-order check below now covers all three mechanisms' numbers
 * at once.
 *
 * A change to either side's order without a matching change here is exactly the defect this guard
 * exists to catch: a `packages/base` file registering a context-hook section whose order collides
 * with a row `packages/code`'s own table already owns, with nothing to notice. 'skills' collided
 * with 'tools:sdk' at order 150 once. It now claims order 160, after tool doctrine and before
 * channel style. The hook writes author field `content`; Core maps that to protocol `text`.
 *
 * A blind spot this file cannot close: packages/base/extensions/hooks-runner forwards user-authored
 * hook scripts, which can return a 'context' hook result carrying a `sections` array with any order
 * they like. Nothing here statically scans those scripts — they are loaded at runtime, not literal
 * source in this repository — so this guard covers first-party packages/base source files that
 * contain a hook-section literal directly, not whatever a script loaded through hooks-runner returns.
 */
const CANONICAL_PROMPT_SECTIONS: ReadonlyArray<{
  id: string
  order: number
  owner: 'code' | 'base' | 'core'
}> = [
  // packages/core/src/request/derive.ts's UNTRUSTED_RULE_SECTION. Prepended ahead of every sorted
  // section rather than sorted in with them, but it still occupies order 0 in the same numbering
  // space, so a future row claiming 0 would collide with it at the wire even though nothing here
  // scans derive.ts to notice.
  { id: 'core:untrusted-envelope', order: 0, owner: 'core' },
  { id: 'persona', order: 100, owner: 'code' },
  { id: 'environment', order: 110, owner: 'code' },
  // Reserved for base, not yet implemented: no file under packages/base currently registers a
  // section with this id. If a base file ever claims order 120, the third test below requires that
  // claim's id to be 'agents-md' -- it does not, on its own, confirm that nothing currently claims
  // the order. See the comment on this row in packages/code/src/prompts/sections.ts.
  { id: 'agents-md', order: 120, owner: 'base' },
  { id: 'coding-doctrine', order: 130, owner: 'code' },
  { id: 'code-doctrine', order: 140, owner: 'code' },
  { id: 'tools:sdk', order: 150, owner: 'code' },
  { id: 'skills', order: 160, owner: 'base' },
  { id: 'channel-style', order: 170, owner: 'code' },
  // packages/core/src/request/contribute.ts's harnessSections(), which folds harness register
  // entries into the same sorted section list at these two fixed orders.
  { id: 'harness:prompt', order: 180, owner: 'core' },
  { id: 'harness:memory', order: 181, owner: 'core' },
  // A context hook's additionalContext travels as a tail note, not a section.
]

// code's own PROMPT_SECTIONS literal always writes source right after order. A context hook's
// author return writes `content` after order; packages/core/src/hooks/returns.ts maps that field
// to the protocol name `text` and rejects a hook that already says `text`.
const CODE_SECTION_RE = /id:\s*'([\w:-]+)'\s*,\s*order:\s*(\d+)\s*,\s*source:/g
const HOOK_SECTION_RE = /id:\s*'([\w:-]+)'\s*,\s*order:\s*(\d+)\s*,\s*content:/g

function extract(re: RegExp, text: string): Array<{ id: string; order: number }> {
  return [...text.matchAll(re)].map((m) => ({ id: m[1] as string, order: Number(m[2]) }))
}

describe('prompt section order table has one claimant per order, across both contribution paths', () => {
  it('the canonical table itself has no duplicate order and no duplicate id', () => {
    const orders = CANONICAL_PROMPT_SECTIONS.map((s) => s.order)
    const ids = CANONICAL_PROMPT_SECTIONS.map((s) => s.id)
    expect(new Set(orders).size).toBe(orders.length)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("packages/code/src/prompts/sections.ts's PROMPT_SECTIONS matches the canonical table exactly", () => {
    const file = join(root, 'packages/code/src/prompts/sections.ts')
    const pairs = extract(CODE_SECTION_RE, readFileSync(file, 'utf8'))
    // Only the rows packages/code's own table is expected to list: it carries every 'code'-owned
    // section plus the reserved 'base' slot, but never a 'core' row (core's orders are never
    // registered in this file — see the 'core'-owned rows' comments above), so comparing against
    // the full canonical table would fail this test for a reason that has nothing to do with code.
    const codeTableRows = CANONICAL_PROMPT_SECTIONS.filter((s) => s.owner === 'code' || s.owner === 'base')
    for (const want of codeTableRows)
      expect(pairs, want.id).toContainEqual({ id: want.id, order: want.order })
    expect(pairs.length, relative(root, file)).toBe(codeTableRows.length)
  })

  it('no packages/base source file registers a context-hook section at an order the table gives to someone else', () => {
    const baseSrcDirs = [join(root, 'packages/base/src'), join(root, 'packages/base/extensions')]
    const byOrder = new Map(CANONICAL_PROMPT_SECTIONS.map((s) => [s.order, s.id]))
    const seenBaseIds = new Set<string>()
    for (const dir of baseSrcDirs) {
      for (const f of listSourceFiles(dir)) {
        if (isTestFile(f)) continue
        const text = readFileSync(f, 'utf8')
        // Scoped to files that actually register a 'context' hook: an incidental id/order pair
        // elsewhere (a fixture object, an unrelated registry) is not a prompt-section claim, and
        // scanning every file for the bare pattern would make this guard fire on those.
        if (!/registerHook\(\s*['"]context['"]/.test(text)) continue
        for (const { id, order } of extract(HOOK_SECTION_RE, text)) {
          const claimant = byOrder.get(order)
          expect(claimant, `${relative(root, f)} claims order ${order} for '${id}'`).toBe(id)
          seenBaseIds.add(id)
        }
      }
    }
    // 'agents-md' is currently the only base-owned row in the table, and it is allowed to stay
    // unclaimed (see its row's comment above) — so this loop has zero iterations today. It is kept
    // rather than deleted because it is not vacuous forever: the day a base-owned row is added back
    // (a real agents-md contributor, or something new), this is what starts requiring it to actually
    // exist rather than silently trusting a stale reservation.
    for (const s of CANONICAL_PROMPT_SECTIONS)
      if (s.owner === 'base' && s.id !== 'agents-md') expect(seenBaseIds.has(s.id), s.id).toBe(true)
  })

  it('the two extractors are not dead regexes: each matches its own file shape and not the other', () => {
    const codeLiteral = "{ id: 'persona', order: 100, source: 'file', owner: 'code' },"
    const hookLiteral =
      "{\n        id: 'example-section',\n        order: 999,\n        content: 'x',\n      }"
    expect(extract(CODE_SECTION_RE, codeLiteral)).toEqual([{ id: 'persona', order: 100 }])
    expect(extract(HOOK_SECTION_RE, hookLiteral)).toEqual([{ id: 'example-section', order: 999 }])
    expect(extract(HOOK_SECTION_RE, codeLiteral)).toEqual([])
    expect(extract(CODE_SECTION_RE, hookLiteral)).toEqual([])
    expect(extract(CODE_SECTION_RE, 'no match here')).toEqual([])
  })
})
