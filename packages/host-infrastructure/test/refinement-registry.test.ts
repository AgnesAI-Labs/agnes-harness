import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RefinementEntryKind } from '@agnes/core-ledger/reduce/refinement-run'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPROVAL_TTL_MS,
  normalizedContentHash,
  PROMOTION_CONFIRMATIONS,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
  type RegistrySkill,
  type Revocation,
  type SaveKind,
  type SaveReceipt,
  type SaveSource,
} from '../src/refinement-registry.js'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-registry-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const T0 = 1_800_000_000_000
const clockAt = (start = T0) => {
  const state = { now: start }
  return Object.assign(() => state.now, {
    set: (value: number) => {
      state.now = value
    },
  })
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const fileOf = (dir: string, root: string) => join(dir, 'refinement', 'workspaces', `${sha256(root)}.json`)

const source = (over: Partial<SaveSource> = {}): SaveSource => ({
  sessionKey: 's1',
  kind: 'memory',
  entryId: 'e1',
  contentHash: 'h-content',
  initiator: 'auto',
  ...over,
})
const paragraph = (over: Partial<RegistryParagraph> = {}): RegistryParagraph => ({
  id: 'p1',
  source: source(),
  contentHash: 'h-paragraph',
  reviewAfter: T0 + REVIEW_AFTER_MS,
  state: 'active',
  fileHash: 'h-file',
  ...over,
})
const skill = (over: Partial<RegistrySkill> = {}): RegistrySkill => ({
  name: 'deploy-notes',
  resourceId: 'res-1',
  revision: 'rev-1',
  source: source({ kind: 'skill', entryId: 'e-skill' }),
  reviewAfter: T0 + REVIEW_AFTER_MS,
  state: 'active',
  archive: [],
  ...over,
})
const revocation = (over: Partial<Revocation> = {}): Revocation => ({
  sessionKey: 's1',
  kind: 'memory',
  entryId: 'e1',
  contentHash: 'h-content',
  action: 'memory-deleted',
  at: T0,
  ...over,
})
const receipt = (over: Partial<SaveReceipt> = {}): SaveReceipt => ({
  receiptId: 'r1',
  commandId: 'c1',
  initiator: 'model',
  source: source({ initiator: 'model' }),
  outcome: 'saved',
  steps: [{ step: 'switch', verdict: 'pass' }],
  at: T0,
  ...over,
})

const make = (root = '/work/a', dir = tempDir(), clock = clockAt()) => ({
  dir,
  clock,
  registry: new RefinementRegistry(dir, root, clock),
})

describe('RefinementRegistry', () => {
  it('exposes the three default constants', () => {
    expect(REVIEW_AFTER_MS).toBe(30 * DAY)
    expect(PROMOTION_CONFIRMATIONS).toBe(2)
    expect(APPROVAL_TTL_MS).toBe(7 * DAY)
  })

  it('a missing or corrupt registry reads as empty and never as valid', () => {
    const { registry, dir } = make()
    const empty = registry.read()
    expect(empty).toMatchObject({ paragraphs: [], skills: [], revocations: [], receipts: [] })
    expect(registry.validity('p1', T0)).toBe('unknown')

    const good = JSON.stringify({
      version: 1,
      revision: '11111111-1111-1111-1111-111111111111',
      paragraphs: [paragraph()],
      skills: [],
      revocations: [],
      receipts: [],
    })
    expect(JSON.parse(good).paragraphs).toHaveLength(1)
    mkdirSync(join(dir, 'refinement', 'workspaces'), { recursive: true })
    const planted = [
      '{not json',
      '',
      '[]',
      'null',
      '{}',
      good.replace('"version":1', '"version":2'),
      good.replace('"state":"active"', '"state":"forever"'),
      good.replace('"reviewAfter":', '"reviewAfter":"soon","x":'),
      good.replace('"revision":"1', '"revision":1'),
      good.replace('"skills":[]', '"skills":{}'),
      `${good.slice(0, -1)},"paragraphs":"dup"}`,
    ]
    for (const text of planted) {
      writeFileSync(fileOf(dir, '/work/a'), text)
      const read = registry.read()
      expect(read.paragraphs, text).toEqual([])
      expect(read.revision).toBe(empty.revision)
      expect(registry.validity('p1', T0), text).toBe('unknown')
    }
    // the same bytes, intact, are believed
    writeFileSync(fileOf(dir, '/work/a'), good)
    expect(registry.validity('p1', T0)).toBe('valid')
  })

  it('an oversized registry file reads as empty', () => {
    const { registry, dir } = make()
    mkdirSync(join(dir, 'refinement', 'workspaces'), { recursive: true })
    writeFileSync(fileOf(dir, '/work/a'), ' '.repeat(9 * 1024 * 1024))
    expect(registry.read().paragraphs).toEqual([])
  })

  it('validity is unknown for an id the registry does not hold', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.paragraphs.push(
        paragraph({ id: 'p-active' }),
        paragraph({ id: 'p-converted', state: 'converted' }),
        paragraph({ id: 'p-removed', state: 'removed' }),
      )
    }, registry.read().revision)
    expect(registry.validity('p-active', T0)).toBe('valid')
    expect(registry.validity('p-missing', T0)).toBe('unknown')
    // only an active paragraph can be vouched for; a marker for the others is an anomaly
    expect(registry.validity('p-converted', T0)).toBe('unknown')
    expect(registry.validity('p-removed', T0)).toBe('unknown')
    expect(registry.validity('', T0)).toBe('unknown')
  })

  it('reviewAfter expiry turns a paragraph expired at exactly 30 days', () => {
    const { registry, clock } = make()
    registry.update((draft) => {
      draft.paragraphs.push(paragraph({ reviewAfter: clock() + REVIEW_AFTER_MS }))
    }, registry.read().revision)
    expect(registry.validity('p1', T0)).toBe('valid')
    expect(registry.validity('p1', T0 + REVIEW_AFTER_MS - 1)).toBe('valid')
    expect(registry.validity('p1', T0 + REVIEW_AFTER_MS)).toBe('expired')
    expect(registry.validity('p1', T0 + REVIEW_AFTER_MS + 1)).toBe('expired')
  })

  it('update rejects a stale revision and writes nothing', () => {
    const { registry, dir } = make()
    const first = registry.read().revision
    const { revision: second } = registry.update((draft) => {
      draft.paragraphs.push(paragraph())
    }, first)
    expect(second).not.toBe(first)
    expect(registry.read().revision).toBe(second)
    const before = readFileSync(fileOf(dir, '/work/a'), 'utf8')

    expect(() =>
      registry.update((draft) => {
        draft.paragraphs.push(paragraph({ id: 'p2' }))
      }, first),
    ).toThrowError(expect.objectContaining({ code: 'REGISTRY_REVISION_CONFLICT' }))
    expect(readFileSync(fileOf(dir, '/work/a'), 'utf8')).toBe(before)

    // a save that changes nothing still moves the revision, so work begun earlier can tell
    const { revision: third } = registry.update(() => {}, second)
    expect(third).not.toBe(second)
    // a mutation that throws writes nothing
    expect(() =>
      registry.update(() => {
        throw new Error('boom')
      }, third),
    ).toThrow('boom')
    expect(registry.read().revision).toBe(third)
    // no temporary file is left behind
    expect(readdirSync(join(dir, 'refinement', 'workspaces'))).toHaveLength(1)
  })

  it('a conflict hands the mutation nothing to run', () => {
    const { registry } = make()
    let ran = false
    expect(() =>
      registry.update(() => {
        ran = true
      }, 'old'),
    ).toThrowError(expect.objectContaining({ code: 'REGISTRY_REVISION_CONFLICT' }))
    expect(ran).toBe(false)
  })

  it('revoked matches the same lineage, the same skill name and the same paragraph content', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.revocations.push(
        revocation({ entryId: 'e-lineage', contentHash: 'h-old', action: 'memory-withdrawn', at: 5 }),
        revocation({ entryId: 'e-deleted', contentHash: 'h-deleted', action: 'memory-deleted', at: 6 }),
        revocation({
          kind: 'skill',
          entryId: 'e-skill',
          contentHash: 'h-skill',
          skillName: 'deploy-notes',
          action: 'skill-uninstalled',
          at: 7,
        }),
      )
    }, registry.read().revision)

    // same lineage: any version of the same source entry
    expect(
      registry.revoked({ sessionKey: 's1', kind: 'memory', entryId: 'e-lineage', contentHash: 'h-new' }),
    ).toMatchObject({ entryId: 'e-lineage', action: 'memory-withdrawn' })
    // renamed entry, same content as a deleted paragraph
    expect(
      registry.revoked({ sessionKey: 's2', kind: 'prompt', entryId: 'e-other', contentHash: 'h-deleted' }),
    ).toMatchObject({ entryId: 'e-deleted', action: 'memory-deleted' })
    // a different entry in a different session with the same skill name
    expect(
      registry.revoked(
        { sessionKey: 's9', kind: 'skill', entryId: 'e-renamed', contentHash: 'h-different' },
        'deploy-notes',
      ),
    ).toMatchObject({ action: 'skill-uninstalled' })

    // no match
    expect(
      registry.revoked({ sessionKey: 's1', kind: 'memory', entryId: 'e-fresh', contentHash: 'h-fresh' }),
    ).toBeUndefined()
    // the same entry id in another session is another lineage
    expect(
      registry.revoked({ sessionKey: 's2', kind: 'memory', entryId: 'e-lineage', contentHash: 'h-new' }),
    ).toBeUndefined()
    // a skill name alone does not match a memory revocation, and content alone does not match a skill
    expect(
      registry.revoked({ sessionKey: 's9', kind: 'skill', entryId: 'x', contentHash: 'h-skill' }),
    ).toBeUndefined()
    expect(
      registry.revoked({ sessionKey: 's9', kind: 'skill', entryId: 'x', contentHash: 'y' }, 'other-name'),
    ).toBeUndefined()
    // deleted memory content does not bar a skill with that hash
    expect(
      registry.revoked({ sessionKey: 's9', kind: 'skill', entryId: 'x', contentHash: 'h-deleted' }),
    ).toBeUndefined()
  })

  it('revoked answers the latest matching record', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.revocations.push(
        revocation({ action: 'memory-deleted', at: 1 }),
        revocation({ action: 'memory-withdrawn', at: 9 }),
      )
    }, registry.read().revision)
    expect(registry.revoked(source())?.at).toBe(9)
  })

  it('renew moves reviewAfter without touching any memory file', () => {
    const root = tempDir()
    const memory = join(root, 'MEMORY.md')
    writeFileSync(memory, '# memory\n')
    const before = { text: readFileSync(memory, 'utf8'), mtime: statSync(memory).mtimeMs }
    const { registry, clock } = make(root)
    registry.update((draft) => {
      draft.paragraphs.push(paragraph())
      draft.skills.push(skill({ state: 'review-disabled' }))
    }, registry.read().revision)

    clock.set(T0 + 31 * DAY)
    expect(registry.validity('p1', clock())).toBe('expired')
    const revision = registry.read().revision
    registry.renew({ paragraphId: 'p1' })
    expect(registry.validity('p1', clock())).toBe('valid')
    expect(registry.read().paragraphs[0]?.reviewAfter).toBe(clock() + REVIEW_AFTER_MS)
    expect(registry.read().revision).not.toBe(revision)

    registry.renew({ skillName: 'deploy-notes' })
    expect(registry.read().skills[0]).toMatchObject({
      reviewAfter: clock() + REVIEW_AFTER_MS,
      state: 'review-disabled',
    })

    expect(readFileSync(memory, 'utf8')).toBe(before.text)
    expect(statSync(memory).mtimeMs).toBe(before.mtime)
    expect(readdirSync(root)).toEqual(['MEMORY.md'])
  })

  it('renew refuses what it cannot renew', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.paragraphs.push(paragraph({ id: 'gone', state: 'removed' }))
      draft.skills.push(skill({ name: 'old', state: 'uninstalled' }))
    }, registry.read().revision)
    const revision = registry.read().revision
    for (const target of [
      { paragraphId: 'missing' },
      { paragraphId: 'gone' },
      { skillName: 'missing' },
      { skillName: 'old' },
    ]) {
      expect(() => registry.renew(target)).toThrowError(
        expect.objectContaining({ code: 'REGISTRY_ENTRY_NOT_RENEWABLE' }),
      )
    }
    expect(registry.read().revision).toBe(revision)
  })

  it('registry files of two workspaces never mix', () => {
    const dir = tempDir()
    const a = new RefinementRegistry(dir, '/work/a', clockAt())
    const b = new RefinementRegistry(dir, '/work/b', clockAt())
    a.update((draft) => {
      draft.paragraphs.push(paragraph())
      draft.revocations.push(revocation())
    }, a.read().revision)

    expect(b.read().paragraphs).toEqual([])
    expect(b.validity('p1', T0)).toBe('unknown')
    expect(b.revoked(source())).toBeUndefined()
    expect(a.validity('p1', T0)).toBe('valid')
    expect(readdirSync(join(dir, 'refinement', 'workspaces'))).toEqual([`${sha256('/work/a')}.json`])

    b.update((draft) => {
      draft.paragraphs.push(paragraph({ id: 'pb' }))
    }, b.read().revision)
    expect(a.read().paragraphs.map((p) => p.id)).toEqual(['p1'])
    expect(b.read().paragraphs.map((p) => p.id)).toEqual(['pb'])
    // a different spelling of the same folder is a different workspace key
    expect(new RefinementRegistry(dir, '/work/a/', clockAt()).read().paragraphs).toEqual([])
  })

  it('persists across instances and hands out copies', () => {
    const dir = tempDir()
    const one = new RefinementRegistry(dir, '/w', clockAt())
    one.update((draft) => {
      draft.skills.push(skill({ archive: ['v1', 'v2'] }))
      draft.receipts.push(receipt())
    }, one.read().revision)
    const two = new RefinementRegistry(dir, '/w', clockAt())
    expect(two.read()).toEqual(one.read())
    expect(two.read().skills[0]?.archive).toEqual(['v1', 'v2'])
    two.read().skills[0]?.archive.push('tampered')
    expect(two.read().skills[0]?.archive).toEqual(['v1', 'v2'])
    expect(statSync(fileOf(dir, '/w')).mode & 0o077).toBe(0)
  })

  it('stores structure and hashes only: receipts and revocations carry no entry text', () => {
    const { registry, dir } = make()
    const marker = 'ENTRY-TEXT-MARKER'
    registry.update((draft) => {
      draft.receipts.push({ ...receipt(), content: marker, title: marker } as SaveReceipt)
      draft.revocations.push({ ...revocation(), content: marker } as Revocation)
      draft.paragraphs.push({ ...paragraph(), content: marker } as RegistryParagraph)
    }, registry.read().revision)
    expect(readFileSync(fileOf(dir, '/work/a'), 'utf8')).not.toContain(marker)
    expect(Object.keys(registry.read().receipts[0] ?? {}).sort()).toEqual(
      ['at', 'commandId', 'initiator', 'outcome', 'receiptId', 'source', 'steps'].sort(),
    )
  })

  it('refuses to store a malformed record', () => {
    const { registry } = make()
    const revision = registry.read().revision
    expect(() =>
      registry.update((draft) => {
        draft.paragraphs.push(paragraph({ state: 'bogus' as RegistryParagraph['state'] }))
      }, revision),
    ).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID' }))
    expect(() =>
      registry.update((draft) => {
        draft.paragraphs.push(paragraph({ reviewAfter: Number.NaN }))
      }, revision),
    ).toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID' }))
    expect(registry.read().revision).toBe(revision)
  })

  it('keeps only the newest receipts', () => {
    const { registry } = make()
    registry.update((draft) => {
      for (let i = 0; i < 600; i++) draft.receipts.push(receipt({ receiptId: `r${i}`, at: i }))
    }, registry.read().revision)
    const receipts = registry.read().receipts
    expect(receipts).toHaveLength(500)
    expect(receipts[0]?.receiptId).toBe('r100')
    expect(receipts.at(-1)?.receiptId).toBe('r599')
  })

  it('never trims a receipt that still waits: an approval or an intent whose result is not known', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.receipts.push(receipt({ receiptId: 'waiting', outcome: 'awaiting-approval', at: 0 }))
      draft.receipts.push(receipt({ receiptId: 'intent', outcome: 'unknown', at: 1 }))
      draft.receipts.push(
        receipt({ receiptId: 'settled-unknown', outcome: 'unknown', reason: 'conflict', at: 2 }),
      )
    }, registry.read().revision)
    for (let batch = 0; batch < 6; batch++)
      registry.update((draft) => {
        for (let i = 0; i < 100; i++)
          draft.receipts.push(
            receipt({
              receiptId: `n${batch}-${i}`,
              outcome: 'refused',
              reason: 'memory-off',
              at: 10 + batch * 100 + i,
            }),
          )
      }, registry.read().revision)
    const receipts = registry.read().receipts
    expect(receipts).toHaveLength(500)
    expect(receipts.slice(0, 2).map((r) => r.receiptId)).toEqual(['waiting', 'intent'])
    // The settled ones went oldest first.
    expect(receipts.some((r) => r.receiptId === 'settled-unknown')).toBe(false)
    expect(receipts.at(-1)?.receiptId).toBe('n5-99')
    expect(receipts[2]?.receiptId).toBe('n1-2')
  })

  it('a receipt with a reason a later build added keeps the records readable', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.receipts.push(
        receipt({ outcome: 'refused', reason: 'skill-review-pending' as NonNullable<SaveReceipt['reason']> }),
      )
      draft.paragraphs.push(paragraph())
    }, registry.read().revision)
    expect(registry.unreadable()).toBe(false)
    expect(registry.read().receipts[0]?.reason).toBe('skill-review-pending')
    expect(registry.read().paragraphs).toHaveLength(1)
  })

  it('keeps every waiting receipt even when they alone are more than the cap', () => {
    const { registry } = make()
    registry.update((draft) => {
      for (let i = 0; i < 520; i++)
        draft.receipts.push(receipt({ receiptId: `w${i}`, outcome: 'awaiting-approval', at: i }))
      draft.receipts.push(receipt({ receiptId: 'done', outcome: 'saved', at: 999 }))
    }, registry.read().revision)
    const ids = registry.read().receipts.map((r) => r.receiptId)
    expect(ids).toHaveLength(520)
    expect(ids).not.toContain('done')
  })

  it('a skill name re-cased on a case-insensitive disk is still the revoked skill', () => {
    const { registry } = make()
    registry.update((draft) => {
      draft.revocations.push(
        revocation({ kind: 'skill', skillName: 'Deploy-Notes', action: 'skill-uninstalled' }),
      )
    }, registry.read().revision)
    for (const name of ['deploy-notes', 'DEPLOY-NOTES', 'Deploy-Notes']) {
      expect(
        registry.revoked({ sessionKey: 's9', kind: 'skill', entryId: 'x', contentHash: 'y' }, name),
        name,
      ).toMatchObject({ action: 'skill-uninstalled' })
    }
    expect(
      registry.revoked({ sessionKey: 's9', kind: 'skill', entryId: 'x', contentHash: 'y' }, 'deploy-note'),
    ).toBeUndefined()
  })

  describe('a file that exists but cannot be believed', () => {
    const plant = (dir: string, textOf: string) => {
      mkdirSync(join(dir, 'refinement', 'workspaces'), { recursive: true })
      writeFileSync(fileOf(dir, '/work/a'), textOf)
    }
    const newer = JSON.stringify({ version: 2, revision: 'x', note: 'written by a newer build' })

    it('is never overwritten by an update', () => {
      const { registry, dir } = make()
      for (const bad of [newer, '{not json', '']) {
        plant(dir, bad)
        expect(() => registry.update(() => {}, registry.read().revision)).toThrowError(
          expect.objectContaining({ code: 'REGISTRY_UNREADABLE' }),
        )
        expect(readFileSync(fileOf(dir, '/work/a'), 'utf8')).toBe(bad)
      }
      // a missing file is not an unreadable one
      rmSync(fileOf(dir, '/work/a'))
      expect(() => registry.update(() => {}, registry.read().revision)).not.toThrow()
    })

    it('blocks every save through revoked while it stays unreadable', () => {
      const { registry, dir } = make()
      expect(registry.revoked(source())).toBeUndefined()
      plant(dir, newer)
      expect(registry.revoked(source())).toMatchObject({
        sessionKey: 's1',
        entryId: 'e1',
        contentHash: 'h-content',
      })
      expect(
        registry.revoked({ sessionKey: 's2', kind: 'skill', entryId: 'x', contentHash: 'y' }, 'any'),
      ).toBeDefined()
      expect(registry.validity('p1', T0)).toBe('unknown')
    })

    it('can be set aside, after which the registry works again', () => {
      const { registry, dir } = make()
      expect(registry.quarantine()).toBeUndefined()
      plant(dir, newer)
      const moved = registry.quarantine()
      expect(moved).toBeDefined()
      expect(existsSync(fileOf(dir, '/work/a'))).toBe(false)
      expect(readFileSync(moved as string, 'utf8')).toBe(newer)
      expect(registry.revoked(source())).toBeUndefined()
      expect(() => registry.update(() => {}, registry.read().revision)).not.toThrow()
    })
  })

  describe('the write lock', () => {
    const lockOf = (dir: string) => `${fileOf(dir, '/work/a')}.lock`
    const options = { lockStaleMs: 5_000, lockWaitMs: 300 }

    it('is gone after an update, also after one that fails', () => {
      const { dir } = make()
      const registry = new RefinementRegistry(dir, '/work/a', clockAt(), options)
      registry.update(() => {}, registry.read().revision)
      expect(existsSync(lockOf(dir))).toBe(false)
      expect(() =>
        registry.update(() => {
          throw new Error('boom')
        }, registry.read().revision),
      ).toThrow('boom')
      expect(existsSync(lockOf(dir))).toBe(false)
      expect(() => registry.update(() => {}, 'old')).toThrow()
      expect(existsSync(lockOf(dir))).toBe(false)
    })

    it('makes a writer wait for a live holder and give up with a coded error', () => {
      const { dir } = make()
      const registry = new RefinementRegistry(dir, '/work/a', clockAt(), options)
      mkdirSync(join(dir, 'refinement', 'workspaces'), { recursive: true })
      writeFileSync(lockOf(dir), 'held')
      const before = Date.now()
      expect(() => registry.update(() => {}, registry.read().revision)).toThrowError(
        expect.objectContaining({ code: 'REGISTRY_LOCK_TIMEOUT' }),
      )
      expect(Date.now() - before).toBeGreaterThanOrEqual(250)
      expect(existsSync(lockOf(dir))).toBe(true)
    })

    it('takes over a lock left by a writer that died', () => {
      const { dir } = make()
      const registry = new RefinementRegistry(dir, '/work/a', clockAt(), options)
      mkdirSync(join(dir, 'refinement', 'workspaces'), { recursive: true })
      writeFileSync(lockOf(dir), 'dead')
      const old = new Date(Date.now() - 60_000)
      utimesSync(lockOf(dir), old, old)
      expect(() => registry.update(() => {}, registry.read().revision)).not.toThrow()
      expect(existsSync(lockOf(dir))).toBe(false)
    })

    it('sweeps a temporary file a crashed write left behind', () => {
      const { dir, registry } = make()
      registry.update(() => {}, registry.read().revision)
      const orphan = `${fileOf(dir, '/work/a')}.crashed.tmp`
      writeFileSync(orphan, 'half')
      registry.update(() => {}, registry.read().revision)
      expect(existsSync(orphan)).toBe(false)
      expect(readdirSync(join(dir, 'refinement', 'workspaces'))).toEqual([`${sha256('/work/a')}.json`])
    })
  })
})

describe('normalizedContentHash', () => {
  it('hashes text that differs only in whitespace or letter case alike', () => {
    const base = normalizedContentHash('Run the  build\nbefore pushing')
    for (const variant of [
      'run the build before pushing',
      '  Run the build before pushing  ',
      'RUN THE\tBUILD\r\n\r\nBEFORE PUSHING',
    ]) {
      expect(normalizedContentHash(variant), variant).toBe(base)
    }
    expect(normalizedContentHash('Run the build before pushing!')).not.toBe(base)
    expect(normalizedContentHash('Run the buildbefore pushing')).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is the hash of the normalised text', () => {
    expect(normalizedContentHash(' A  b ')).toBe(sha256('a b'))
  })
})

describe('shared save types', () => {
  it('SaveKind is the refinement entry kind', () => {
    const kind: RefinementEntryKind = 'skill' satisfies SaveKind
    const back: SaveKind = kind
    expect(back).toBe('skill')
  })
})
