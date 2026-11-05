import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MemoryApprovalResult,
  MemoryFilePort,
  MemoryParagraphValidity,
  MemoryProposal,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { memoryParagraphConformance } from '@agnes/extension-api/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { fileMemoryProvider } from '../src/index.js'
import { parseParagraphs } from '../src/paragraphs.js'

const A = 'ra000000001'
const B = 'rb000000002'
const C = 'rc000000003'
const OMITTED = (n: number) => `[${n} task-experience paragraphs omitted: expired or unverifiable]`
const block = (id: string, text: string) => `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->\n`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const homes: string[] = []
const fallback: MemoryFilePort = {
  read: async () => {
    throw new Error('outside memory')
  },
  write: async () => {
    throw new Error('outside memory')
  },
  list: async () => {
    throw new Error('outside memory')
  },
  stat: async () => {
    throw new Error('outside memory')
  },
}

/** A Host-side view whose answers the test sets; revision moves with every change. */
function view(initial: Record<string, MemoryParagraphValidity> = {}) {
  const answers = new Map(Object.entries(initial))
  let revision = 1
  return {
    view: {
      revision: () => `v${revision}`,
      validity: (id: string) => answers.get(id) ?? 'unknown',
    } satisfies MemoryValidityView,
    set(id: string, value: MemoryParagraphValidity) {
      answers.set(id, value)
      revision++
    },
    bump() {
      revision++
    },
  }
}

async function fixture(options: { validity?: MemoryValidityView; home?: string } = {}) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'agh-memory-paragraphs-')))
  if (!options.home) homes.push(home)
  const session = fileMemoryProvider.open({
    home,
    workspaceRoot: home,
    sessionKey: 'one',
    ...(options.validity ? { validity: options.validity } : {}),
  })
  const files = (
    turn: number,
    approve: (proposal: MemoryProposal) => Promise<MemoryApprovalResult> = async () => ({
      status: 'approved',
    }),
  ) =>
    session.files(
      fallback,
      { sessionKey: 'one', turn, toolUseId: 'tool' },
      new AbortController().signal,
      approve,
    )
  const index = join(session.root, 'MEMORY.md')
  const raw = async () => readFile(index, 'utf8')
  const paragraphs = (source: MemorySource = { sessionKey: 'one', turn: 3, maintenance: 'run-1' }) => {
    const port = session.paragraphs?.(source, new AbortController().signal)
    if (!port) throw new Error('memory-file must offer paragraphs')
    return port
  }
  return { home, session, files, index, raw, paragraphs }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

describe('parseParagraphs', () => {
  it('finds well-formed paragraphs and names every anomaly', () => {
    const source = [
      'intro',
      block(A, 'alpha'),
      `<!-- refinement:${B} -->`,
      'never closed',
      block(C, 'gamma'),
      `<!-- /refinement:${A} -->`,
      '<!-- refinement:not-an-id -->',
    ].join('\n')
    const parsed = parseParagraphs(source)
    expect(parsed.paragraphs.map(({ id, text }) => ({ id, text }))).toEqual([{ id: C, text: 'gamma' }])
    expect(parsed.anomalies.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: A, kind: 'duplicate' },
      { id: B, kind: 'unclosed' },
      { id: A, kind: 'stray' },
      { id: undefined, kind: 'unclosed' },
    ])
    const nested = parseParagraphs(
      `<!-- refinement:${A} -->\n${block(B, 'inner')}<!-- /refinement:${A} -->\n`,
    )
    expect(nested.paragraphs).toEqual([])
    expect(nested.anomalies.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: A, kind: 'nested' },
      { id: B, kind: 'nested' },
    ])
  })

  it('reports offsets that cut a paragraph out cleanly', () => {
    const source = `before\n${block(A, 'alpha\nbeta')}after`
    const [paragraph] = parseParagraphs(source).paragraphs
    expect(paragraph?.text).toBe('alpha\nbeta')
    expect(source.slice(0, paragraph!.start) + source.slice(paragraph!.end)).toBe('before\nafter')
  })
})

describe('file memory managed paragraphs', () => {
  it('a file without markers gives the same snapshot bytes and revision as before', async () => {
    const plain = await fixture()
    await plain.session.configure({ mode: 'auto' })
    const content = 'Workspace convention: focused changes.\n<!-- an ordinary comment -->\n'
    await writeFile(plain.index, content)
    const tracked = view({ [A]: 'valid' })
    const withView = await fixture({ home: plain.home, validity: tracked.view })
    const before = await plain.session.snapshot(1)
    const after = await withView.session.snapshot(1)
    // The revision formula from before managed paragraphs existed: file hashes plus the user index hash.
    expect(before?.revision).toBe(sha(JSON.stringify([[['MEMORY.md', sha(content)]], sha('')])))
    expect(after).toEqual(before)
    expect(text(await withView.files(1).read(withView.index))).toBe(content)
    expect(await withView.files(1).revision?.(withView.index)).toBe(before?.revision)
    expect(await withView.files(1).stat(withView.index)).toMatchObject({ size: Buffer.byteLength(content) })
    // A view revision change does not move the revision of a file without markers.
    tracked.bump()
    expect((await withView.session.snapshot(2))?.revision).toBe(before?.revision)
    expect(await withView.session.snapshot(2)).toEqual(await plain.session.snapshot(2))
  })

  it('an expired paragraph is omitted from the snapshot, from read, paged read and list, with a count line', async () => {
    const tracked = view({ [A]: 'valid', [B]: 'expired' })
    const f = await fixture({ validity: tracked.view })
    await f.session.configure({ mode: 'auto' })
    const stored = `Human note\n\n${block(A, 'Run pnpm lint before commit.')}\n${block(B, 'Old build command.')}tail\n`
    await writeFile(f.index, stored)
    const expected = `Human note\n\n${block(A, 'Run pnpm lint before commit.')}\n${OMITTED(1)}\ntail\n`
    const snapshot = await f.session.snapshot(1)
    expect(snapshot?.content).toContain(expected)
    expect(snapshot?.content).not.toContain('Old build command.')
    expect(text(await f.files(1).read(f.index))).toBe(expected)
    expect(text(await f.files(1).read(f.index, { offset: 5, limit: 20 }))).toBe(
      Buffer.from(expected).subarray(5, 25).toString('utf8'),
    )
    expect(await f.files(1).stat(f.index)).toMatchObject({ size: Buffer.byteLength(expected) })
    expect(await f.files(1).list(f.session.root)).toEqual([{ name: 'MEMORY.md', kind: 'file' }])
    // Adjacent hidden paragraphs share one count line.
    tracked.set(A, 'expired')
    const two = `${block(A, 'one')}${block(B, 'two')}`
    await writeFile(f.index, two)
    expect(text(await f.files(2).read(f.index))).toBe(`${OMITTED(2)}\n`)
  })

  it('a delivered paragraph is left out of the snapshot silently and shown on read', async () => {
    const f = await fixture({ validity: view({ [A]: 'valid', [B]: 'delivered' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `Human note\n\n${block(A, 'Run pnpm lint before commit.')}\n${block(B, 'Saved lesson.')}tail\n`
    await writeFile(f.index, stored)
    const snapshot = await f.session.snapshot(1)
    expect(snapshot?.content).toContain(`Human note\n\n${block(A, 'Run pnpm lint before commit.')}\ntail\n`)
    expect(snapshot?.content).not.toContain('Saved lesson.')
    expect(snapshot?.content).not.toContain('task-experience paragraphs omitted')
    expect(text(await f.files(1).read(f.index))).toBe(stored)
  })

  it('whole-file writes and replaceExact check a delivered paragraph against the read view', async () => {
    const f = await fixture({ validity: view({ [B]: 'delivered' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `Top\n${block(B, 'Saved lesson.')}Bottom\n`
    await writeFile(f.index, stored)
    const files = f.files(1)
    await files.replaceExact?.(f.index, 'Bottom', 'Bottom line')
    expect(await f.raw()).toBe(`Top\n${block(B, 'Saved lesson.')}Bottom line\n`)
    const seen = text(await f.files(2).read(f.index))
    await f.files(2).write(f.index, `${seen}more\n`)
    expect(await f.raw()).toBe(`Top\n${block(B, 'Saved lesson.')}Bottom line\nmore\n`)
  })

  it('the omitted set changes memoryRevision', async () => {
    const tracked = view({ [A]: 'valid' })
    const f = await fixture({ validity: tracked.view })
    await f.session.configure({ mode: 'auto' })
    await writeFile(f.index, block(A, 'Prefer focused commits.'))
    const first = await f.session.snapshot(1)
    expect(first?.content).toContain('Prefer focused commits.')
    tracked.set(A, 'expired')
    // The same turn keeps its snapshot; the next turn sees the new left-out set.
    expect(await f.session.snapshot(1)).toEqual(first)
    const second = await f.session.snapshot(2)
    expect(second?.revision).not.toBe(first?.revision)
    expect(second?.content).toContain(OMITTED(1))
    expect(await f.files(2).revision?.(f.index)).toBe(second?.revision)
    // With managed paragraphs present, a view revision change alone moves the revision too.
    tracked.bump()
    expect((await f.session.snapshot(3))?.revision).not.toBe(second?.revision)
  })

  it('unknown ids, duplicate ids, unclosed or nested markers are all omitted for the agent', async () => {
    const tracked = view({ [A]: 'valid', [B]: 'valid' })
    const f = await fixture({ validity: tracked.view })
    await f.session.configure({ mode: 'auto' })
    const cases = [
      { stored: block(C, 'not in the registry'), leftOut: 'not in the registry' },
      { stored: `${block(A, 'first copy')}${block(A, 'second copy')}`, leftOut: 'copy' },
      { stored: `<!-- refinement:${A} -->\nnever closed\n`, leftOut: 'never closed' },
      {
        stored: `<!-- refinement:${A} -->\nouter\n${block(B, 'inner')}<!-- /refinement:${A} -->\n`,
        leftOut: 'outer',
      },
      { stored: `kept\n<!-- /refinement:${A} -->\n`, leftOut: 'refinement' },
    ]
    let turn = 1
    for (const { stored, leftOut } of cases) {
      await writeFile(f.index, stored)
      const snapshot = await f.session.snapshot(turn)
      expect(snapshot?.content).not.toContain(leftOut)
      expect(snapshot?.content).toContain('task-experience paragraphs omitted')
      expect(text(await f.files(turn).read(f.index))).not.toContain(leftOut)
      turn++
    }
    // Without a validity view every managed paragraph is left out.
    const blind = await fixture({ home: f.home })
    await writeFile(f.index, `kept\n${block(A, 'valid elsewhere')}`)
    expect(text(await blind.files(turn).read(blind.index))).toBe(`kept\n${OMITTED(1)}\n`)
    // A view that throws answers as unverifiable.
    const throwing = await fixture({
      home: f.home,
      validity: {
        revision: () => 'x',
        validity: () => {
          throw new Error('broken view')
        },
      },
    })
    expect(text(await throwing.files(turn).read(throwing.index))).toBe(`kept\n${OMITTED(1)}\n`)
  })

  it('the human readFile shows the raw text', async () => {
    const f = await fixture({ validity: view({ [A]: 'expired' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `note\n${block(A, 'expired text')}`
    await writeFile(f.index, stored)
    expect((await f.session.readFile('MEMORY.md')).content).toBe(stored)
    expect((await f.session.inspect()).files).toMatchObject([
      { path: 'MEMORY.md', bytes: Buffer.byteLength(stored) },
    ])
    const edited = `${stored}human line\n`
    await f.session.editFile('MEMORY.md', edited, sha(stored))
    expect(await f.raw()).toBe(edited)
  })

  it('editing visible paragraph A keeps hidden paragraph B byte for byte', async () => {
    const f = await fixture({ validity: view({ [A]: 'valid', [B]: 'expired' }).view })
    await f.session.configure({ mode: 'auto' })
    const hidden = block(B, 'Hidden: use the legacy build.\r\n  odd   spacing kept')
    await writeFile(f.index, `Top\n${block(A, 'Use pnpm.')}\n${hidden}\nBottom\n`)
    const files = f.files(1)
    await files.replaceExact?.(f.index, 'Use pnpm.', 'Use pnpm 10.')
    await files.replaceExact?.(f.index, 'Bottom', 'Bottom line')
    expect(await f.raw()).toBe(`Top\n${block(A, 'Use pnpm 10.')}\n${hidden}\nBottom line\n`)
  })

  it('a whole-file write is refused with MEMORY_HIDDEN_PARAGRAPHS while a paragraph is hidden', async () => {
    const f = await fixture({ validity: view({ [A]: 'expired' }).view })
    await f.session.configure({ mode: 'ask' })
    const stored = `Visible\n${block(A, 'Hidden text')}`
    await writeFile(f.index, stored)
    let asked = false
    const files = f.files(1, async () => {
      asked = true
      return { status: 'approved' }
    })
    const seen = text(await files.read(f.index))
    await expect(files.write(f.index, `${seen}more\n`)).rejects.toMatchObject({
      code: 'MEMORY_HIDDEN_PARAGRAPHS',
    })
    await expect(files.write(f.index, 'Visible only\n')).rejects.toMatchObject({
      code: 'MEMORY_HIDDEN_PARAGRAPHS',
    })
    expect(asked).toBe(false)
    expect(await f.raw()).toBe(stored)
  })

  it('a write that adds, removes or alters a marker is refused', async () => {
    const f = await fixture({ validity: view({ [A]: 'valid', [B]: 'valid' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `Note\n${block(A, 'Alpha')}`
    await writeFile(f.index, stored)
    const files = f.files(1)
    for (const candidate of [
      `${stored}${block(B, 'Beta')}`,
      'Note\nAlpha\n',
      `Note\n${block(B, 'Alpha')}`,
      `Note\n<!-- refinement:${A} -->\nAlpha\n<!-- /refinement:${A} -->\n<!-- refinement: oops -->\n`,
      `Note\n<!-- refinement:${A} -->\nAlpha\n`,
    ]) {
      await expect(files.write(f.index, candidate)).rejects.toMatchObject({ code: 'MEMORY_MARKER_CHANGED' })
    }
    await expect(
      files.write(join(f.session.root, 'topic.md'), block(B, 'smuggled into a topic')),
    ).rejects.toMatchObject({ code: 'MEMORY_MARKER_CHANGED' })
    expect(await f.raw()).toBe(stored)
    // Text outside managed paragraphs may change while every marker and paragraph stays.
    await files.write(f.index, `Note changed\n${block(A, 'Alpha')}`)
    expect(await f.raw()).toBe(`Note changed\n${block(A, 'Alpha')}`)
  })

  it('a whole-file write that moves a marker across other lines or edits a managed paragraph is refused', async () => {
    const f = await fixture({ validity: view({ [A]: 'valid' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `${block(A, 'Alpha')}Human line\n`
    await writeFile(f.index, stored)
    const files = f.files(1)
    // Moving the closing marker below a human line would make that line expire with the paragraph.
    await expect(
      files.write(f.index, `<!-- refinement:${A} -->\nAlpha\nHuman line\n<!-- /refinement:${A} -->\n`),
    ).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_TEXT_CHANGED' })
    await expect(files.write(f.index, `${block(A, 'Alpha revised')}Human line\n`)).rejects.toMatchObject({
      code: 'MEMORY_PARAGRAPH_TEXT_CHANGED',
    })
    expect(await f.raw()).toBe(stored)
    // The paragraph's own text changes through exact replacement.
    await files.replaceExact?.(f.index, 'Alpha', 'Alpha revised')
    expect(await f.raw()).toBe(`${block(A, 'Alpha revised')}Human line\n`)
  })

  it('a damaged opening marker hides the paragraph body', async () => {
    const f = await fixture({ validity: view({ [B]: 'valid' }).view })
    await f.session.configure({ mode: 'auto' })
    const body = 'damaged body'
    const close = `<!-- /refinement:${B} -->`
    const cases = [
      { name: 'trailing space', stored: `<!-- refinement:${B} --> \n${body}\n${close}\nhuman\n` },
      { name: 'typo in the id', stored: `<!-- refinement:rb00000002 -->\n${body}\n${close}\nhuman\n` },
      { name: 'malformed opener', stored: `<!-- refinement:r-bad -->\n${body}\n${close}\nhuman\n` },
      { name: 'malformed opener, no closer', stored: `<!--refinement: ${B}-->\n${body}\nhuman\n` },
    ]
    let turn = 1
    for (const { name, stored } of cases) {
      await writeFile(f.index, stored)
      const files = f.files(turn)
      const snapshot = await f.session.snapshot(turn)
      expect(snapshot?.content, name).not.toContain(body)
      expect(text(await files.read(f.index)), name).not.toContain(body)
      for (let offset = 0; offset < 40; offset += 7)
        expect(text(await files.read(f.index, { offset, limit: 30 })), name).not.toContain('damaged')
      await expect(files.replaceExact?.(f.index, body, 'x'), name).rejects.toMatchObject({
        code: 'MEMORY_REPLACE_NOT_FOUND',
      })
      expect(await f.raw(), name).toBe(stored)
      turn++
    }
    const closed = parseParagraphs(cases[2]!.stored)
    expect(closed.paragraphs).toEqual([])
    expect(closed.anomalies).toMatchObject([
      { kind: 'unclosed', start: 0, end: cases[2]!.stored.indexOf('human') },
    ])
  })

  it('a byte order mark before the first marker is kept and does not damage the paragraph', async () => {
    const tracked = view({ [B]: 'expired' })
    const f = await fixture({ validity: tracked.view })
    await f.session.configure({ mode: 'auto' })
    const stored = `\uFEFF${block(B, 'expired body')}human\n`
    await writeFile(f.index, stored)
    const files = f.files(1)
    expect(text(await files.read(f.index))).toBe(`\uFEFF${OMITTED(1)}\nhuman\n`)
    expect((await f.session.snapshot(1))?.content).not.toContain('expired body')
    await expect(files.replaceExact?.(f.index, 'expired body', 'x')).rejects.toMatchObject({
      code: 'MEMORY_REPLACE_NOT_FOUND',
    })
    tracked.set(B, 'valid')
    expect(text(await f.files(2).read(f.index))).toBe(stored)
    const port = f.paragraphs()
    expect((await port.list()).paragraphs).toEqual([{ id: B, text: 'expired body', validity: 'valid' }])
    await port.commit(await port.propose({ op: 'remove', id: B }))
    expect(await f.raw()).toBe('\uFEFFhuman\n')
  })

  it('a large index full of openers is parsed in linear time and not filtered once over its cap', async () => {
    const f = await fixture({ validity: view().view })
    await f.session.configure({ mode: 'auto' })
    const stored = Array.from(
      { length: 30_000 },
      (_, n) => `<!-- refinement:r${n.toString(36).padStart(10, '0')} -->\n`,
    ).join('')
    expect(Buffer.byteLength(stored)).toBeGreaterThan(900_000)
    const fastest = (run: () => unknown) => {
      let best = Number.POSITIVE_INFINITY
      for (let round = 0; round < 3; round++) {
        const started = performance.now()
        run()
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    expect(fastest(() => parseParagraphs(stored))).toBeLessThan(100)
    await writeFile(f.index, stored)
    const started = performance.now()
    const snapshot = await f.session.snapshot(1)
    expect(performance.now() - started).toBeLessThan(100)
    expect(snapshot?.content).toContain('[Memory omitted: consolidate the index')
    // The over-cap index still refuses a whole-file write that would drop managed text.
    await expect(f.files(1).write(f.index, 'replacement\n')).rejects.toMatchObject({
      code: 'MEMORY_HIDDEN_PARAGRAPHS',
    })
  })

  it('replaceExact refuses text inside a hidden paragraph or across a marker', async () => {
    const f = await fixture({ validity: view({ [A]: 'valid', [B]: 'expired' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `Same\nSame\nHead\n${block(A, 'Alpha')}Middle\n${block(B, 'Hidden beta')}End\n`
    await writeFile(f.index, stored)
    const files = f.files(1)
    const refusals: [string, string, string][] = [
      ['Hidden beta', 'changed', 'MEMORY_REPLACE_NOT_FOUND'],
      [`Middle\n${OMITTED(1)}`, 'Middle\n', 'MEMORY_HIDDEN_PARAGRAPHS'],
      [`Head\n<!-- refinement:${A} -->`, 'Head', 'MEMORY_MARKER_CHANGED'],
      [`Alpha\n<!-- /refinement:${A} -->\nMiddle`, 'Alpha', 'MEMORY_MARKER_CHANGED'],
      [`<!-- /refinement:${A} -->\n`, '', 'MEMORY_MARKER_CHANGED'],
      ['Same', 'Other', 'MEMORY_REPLACE_AMBIGUOUS'],
      ['', 'x', 'MEMORY_REPLACE_NOT_FOUND'],
      ['Middle', block(C, 'smuggled').trimEnd(), 'MEMORY_MARKER_CHANGED'],
    ]
    for (const [oldText, newText, code] of refusals)
      await expect(files.replaceExact?.(f.index, oldText, newText)).rejects.toMatchObject({ code })
    expect(await f.raw()).toBe(stored)
  })

  it('replaceExact goes through the exact-proposal approval and refuses a stale approval', async () => {
    const f = await fixture({ validity: view({ [A]: 'expired' }).view })
    await f.session.configure({ mode: 'ask' })
    const stored = `Keep\n${block(A, 'Hidden')}`
    await writeFile(f.index, stored)
    const proposals: MemoryProposal[] = []
    await expect(
      f
        .files(1, async (proposal) => {
          proposals.push(proposal)
          return { status: 'rejected' }
        })
        .replaceExact?.(f.index, 'Keep', 'Kept'),
    ).rejects.toMatchObject({ code: 'MEMORY_APPROVAL_REJECTED' })
    expect(proposals[0]).toMatchObject({
      path: f.index,
      baseHash: sha(stored),
      newHash: sha(`Kept\n${block(A, 'Hidden')}`),
      source: { sessionKey: 'one', turn: 1 },
    })
    expect(await f.raw()).toBe(stored)
    // The file changes while the approval waits: the approved write never lands on the new file.
    await expect(
      f
        .files(2, async () => {
          await writeFile(f.index, `Human edit\n${stored}`)
          return { status: 'approved' }
        })
        .replaceExact?.(f.index, 'Keep', 'Kept'),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(await f.raw()).toBe(`Human edit\n${stored}`)
  })

  it('replaceExact delegates ordinary files and refuses memory while off', async () => {
    const f = await fixture()
    await expect(f.files(1).replaceExact?.(f.index, 'a', 'b')).rejects.toMatchObject({
      code: 'MEMORY_DISABLED',
    })
    await expect(f.files(1).replaceExact?.(join(f.home, 'plain.md'), 'a', 'b')).rejects.toMatchObject({
      code: 'MEMORY_SCOPE_DENIED',
    })
    const calls: string[][] = []
    const delegated = f.session.files(
      { ...fallback, replaceExact: async (...args) => void calls.push(args) },
      { sessionKey: 'one', turn: 1 },
      new AbortController().signal,
      async () => ({ status: 'approved' }),
    )
    await delegated.replaceExact?.(join(f.home, 'plain.md'), 'a', 'b')
    expect(calls).toEqual([[join(f.home, 'plain.md'), 'a', 'b']])
  })
})

describe('file memory paragraph port', () => {
  it('passes the paragraph-port conformance checks', async () => {
    const passed = await memoryParagraphConformance(async () => {
      const f = await fixture({ validity: view().view })
      await f.session.configure({ mode: 'auto' })
      await writeFile(f.index, 'Human preference.\n')
      return {
        port: f.paragraphs(),
        editStored: async () => writeFile(f.index, `${await f.raw()}Edited by a person.\n`),
        ids: [A, B, C],
      }
    })
    expect(passed).toEqual([
      'list',
      'single-change-without-base',
      'batch-in-one-commit',
      'stale-base-refused',
      'stale-commit-refused',
      'all-or-nothing',
    ])
  })

  it('appends new paragraphs, replaces in place, removes cleanly and never touches other text', async () => {
    const tracked = view({ [A]: 'valid', [B]: 'expired' })
    const f = await fixture({ validity: tracked.view })
    await f.session.configure({ mode: 'auto' })
    const original = `Human\n${block(B, 'Hidden beta')}Tail\n`
    await writeFile(f.index, original)
    const port = f.paragraphs()
    expect(await port.list()).toEqual({
      hash: sha(original),
      paragraphs: [{ id: B, text: 'Hidden beta', validity: 'expired' }],
    })
    const added = await port.commit(await port.propose({ op: 'put', id: A, text: 'Alpha' }))
    expect(await f.raw()).toBe(`${original}\n${block(A, 'Alpha')}`)
    expect(added.hash).toBe(sha(await f.raw()))
    await port.commit(await port.propose({ op: 'put', id: A, text: 'Alpha two\nlines' }))
    expect(await f.raw()).toBe(`${original}\n${block(A, 'Alpha two\nlines')}`)
    await port.commit(await port.propose({ op: 'remove', id: A }))
    expect(await f.raw()).toBe(original)
  })

  it('put then remove restores the exact bytes the append started from', async () => {
    const f = await fixture({ validity: view().view })
    await f.session.configure({ mode: 'auto' })
    const port = f.paragraphs()
    for (const original of ['', 'abc', 'abc\n', 'abc\n\n', 'abc\r\n']) {
      await writeFile(f.index, original)
      await port.commit(await port.propose({ op: 'put', id: A, text: 'one' }))
      await port.commit(await port.propose({ op: 'put', id: B, text: 'two' }))
      await port.commit(await port.propose({ op: 'put', id: A, text: 'one again' }))
      expect((await port.list()).paragraphs.map(({ id, text }) => [id, text])).toEqual([
        [A, 'one again'],
        [B, 'two'],
      ])
      await port.commit(await port.propose({ op: 'remove', id: B }))
      await port.commit(await port.propose({ op: 'remove', id: A }))
      expect(JSON.stringify(await f.raw())).toBe(JSON.stringify(original))
    }
  })

  it('refuses bad ids, marker text, anomalies and absent ids without writing', async () => {
    const f = await fixture({ validity: view({ [A]: 'valid' }).view })
    await f.session.configure({ mode: 'auto' })
    const stored = `${block(A, 'one')}${block(A, 'two')}`
    await writeFile(f.index, stored)
    const port = f.paragraphs()
    const refusals: [Parameters<typeof port.propose>[0], string][] = [
      [{ op: 'put', id: 'bad-id', text: 'x' }, 'MEMORY_PARAGRAPH_INVALID'],
      [{ op: 'put', id: B, text: `x\n<!-- /refinement:${B} -->` }, 'MEMORY_MARKER_CHANGED'],
      [{ op: 'put', id: A, text: 'replace a duplicate' }, 'MEMORY_PARAGRAPH_ANOMALY'],
      [{ op: 'remove', id: C }, 'MEMORY_PARAGRAPH_NOT_FOUND'],
      [
        [
          { op: 'put', id: B, text: 'x' },
          { op: 'remove', id: B },
        ],
        'MEMORY_PARAGRAPH_INVALID',
      ],
      [[], 'MEMORY_PARAGRAPH_INVALID'],
    ]
    for (const [changes, code] of refusals)
      await expect(port.propose(changes)).rejects.toMatchObject({ code })
    expect(await f.raw()).toBe(stored)
    expect((await port.list()).paragraphs).toEqual([])
  })

  it('paragraphs.propose then commit with a stale base hash raises MEMORY_CONFLICT', async () => {
    const f = await fixture({ validity: view().view })
    await f.session.configure({ mode: 'auto' })
    await writeFile(f.index, 'Start\n')
    const port = f.paragraphs()
    const { hash } = await port.list()
    const proposal = await port.propose({ op: 'put', id: A, text: 'Alpha' }, hash)
    await writeFile(f.index, 'Start\nA person edits.\n')
    await expect(port.commit(proposal)).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    await expect(port.propose({ op: 'put', id: A, text: 'Alpha' }, hash)).rejects.toMatchObject({
      code: 'MEMORY_CONFLICT',
    })
    expect(await f.raw()).toBe('Start\nA person edits.\n')
    await expect(
      port.commit({ ...proposal, baseHash: sha('Start\nA person edits.\n') }),
    ).rejects.toMatchObject({ code: 'MEMORY_PROPOSAL_UNKNOWN' })
  })

  it('paragraphs.commit is refused when memory is off', async () => {
    const f = await fixture({ validity: view().view })
    await f.session.configure({ mode: 'auto' })
    const port = f.paragraphs()
    const proposal = await port.propose({ op: 'put', id: A, text: 'Alpha' })
    await f.session.configure({ mode: 'off' })
    await expect(port.commit(proposal)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' })
    await expect(port.propose({ op: 'put', id: A, text: 'Alpha' })).rejects.toMatchObject({
      code: 'MEMORY_DISABLED',
    })
    // A proposal made under auto never commits once the mode has become ask.
    await f.session.configure({ mode: 'auto' })
    const auto = await port.propose({ op: 'put', id: A, text: 'Alpha' })
    await f.session.configure({ mode: 'ask' })
    await expect(port.commit(auto)).rejects.toMatchObject({ code: 'MEMORY_POLICY_CHANGED' })
    expect((await f.session.readFile('MEMORY.md')).content).toBe('')
  })

  it('keeps the maintenance run id in writer.json and out of the inspection older clients validate', async () => {
    const f = await fixture({ validity: view().view })
    await f.session.configure({ mode: 'auto' })
    const port = f.paragraphs({ sessionKey: 'one', turn: 4, maintenance: 'run-42' })
    await port.commit(await port.propose({ op: 'put', id: A, text: 'Alpha' }))
    expect(JSON.parse(await readFile(join(f.session.root, 'writer.json'), 'utf8'))).toEqual({
      sessionKey: 'one',
      turn: 4,
      maintenance: 'run-42',
    })
    const { lastWriter } = await f.session.inspect()
    expect(lastWriter).toEqual({ sessionKey: 'one', turn: 4 })
    // Clients older than the maintenance field validate lastWriter against a closed schema with
    // exactly these properties.
    const older = ['sessionKey', 'toolUseId', 'turn']
    const schema = JSON.parse(
      await readFile(new URL('../../protocol/schema/app-server.json', import.meta.url), 'utf8'),
    ).$defs.MemorySource as { properties: Record<string, unknown>; additionalProperties: boolean }
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual(['maintenance', ...older])
    expect(Object.keys(lastWriter ?? {}).every((key) => older.includes(key))).toBe(true)
    expect(() => f.paragraphs({ sessionKey: 'one', turn: 4, maintenance: 'r'.repeat(129) })).toThrowError(
      expect.objectContaining({ code: 'MEMORY_INVALID_METADATA' }),
    )
  })
})
