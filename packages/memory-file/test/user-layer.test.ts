import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MemoryParagraphPort,
  MemoryParagraphValidity,
  MemorySession,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { memoryParagraphConformance } from '@agnes/extension-api/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { fileMemoryProvider } from '../src/index.js'
import { renderUserLayer, userLayerBytes } from '../src/user-layer.js'

const A = 'ra000000001'
const B = 'rb000000002'
const C = 'rc000000003'
const block = (id: string, text: string) => `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->\n`
const LAYER = 'User memory (read-only for the agent):\n'
const HAND = '# Preferences\n\n- Answer in short sentences.\n'
const SOURCE: MemorySource = { sessionKey: 'refinement:workspace', turn: 0, maintenance: 'run-1' }

/** A Host-side view whose answers the test sets; revision moves with every change. */
function view(initial: Record<string, MemoryParagraphValidity> = {}, delivers = false) {
  const answers = new Map(Object.entries(initial))
  let revision = 1
  return {
    view: {
      revision: () => `v${revision}`,
      validity: (id: string) => answers.get(id) ?? 'unknown',
      ...(delivers ? { delivers: true } : {}),
    } satisfies MemoryValidityView,
    set(id: string, value: MemoryParagraphValidity) {
      answers.set(id, value)
      revision++
    },
  }
}

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function fixture(options: { userValidity?: MemoryValidityView; mode?: 'off' | 'auto' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'agh-user-layer-'))
  homes.push(home)
  const workspace = join(home, 'ws')
  await mkdir(workspace)
  const userDir = join(home, 'memory', 'user')
  await mkdir(userDir, { recursive: true })
  const userFile = join(userDir, 'MEMORY.md')
  const open = (sessionKey = 'one'): MemorySession =>
    fileMemoryProvider.open({
      home,
      workspaceRoot: workspace,
      sessionKey,
      ...(options.userValidity ? { userValidity: options.userValidity } : {}),
    })
  const session = open()
  await session.configure({ mode: options.mode ?? 'auto', userEnabled: true })
  const port = (): MemoryParagraphPort => {
    const made = session.userParagraphs?.(SOURCE, new AbortController().signal)
    if (!made) throw new Error('no user paragraph port')
    return made
  }
  const userLayer = async (turn: number) => {
    const content = (await session.snapshot(turn))?.content ?? ''
    return content.includes(LAYER) ? (content.split(LAYER)[1] ?? '') : ''
  }
  return { home, session, open, userFile, port, userLayer }
}

describe('user memory: saved sections in what the agent reads', () => {
  it('a user memory file without markers is shown exactly as stored', () => {
    const text = `${HAND}\n<!-- not a marker -->\n`
    expect(renderUserLayer(text, undefined)).toMatchObject({ text, managed: false, omittedIds: [] })
  })

  it('hand-written text comes first and saved sections in force follow it, without their markers', () => {
    const { view: v } = view({ [A]: 'valid', [B]: 'valid' })
    const stored = `${block(A, 'Lesson A.')}\n${HAND}\n${block(B, 'Lesson B.')}`
    const rendered = renderUserLayer(stored, v)
    expect(rendered.text).toBe(`${HAND.trimEnd()}\n\nLesson A.\n\nLesson B.\n`)
    expect(rendered.text).not.toContain('refinement:')
  })

  it('an expired user-level RSI section is omitted with a count and changes the revision', async () => {
    const answers = view({ [A]: 'valid', [B]: 'valid' })
    const f = await fixture({ userValidity: answers.view })
    await writeFile(f.userFile, `${HAND}\n${block(A, 'Lesson A.')}\n${block(B, 'Lesson B.')}`)
    const before = await f.session.snapshot(1)
    expect(await f.userLayer(1)).toContain('Lesson B.')
    answers.set(B, 'expired')
    const after = await f.session.snapshot(2)
    const layer = await f.userLayer(2)
    expect(layer).toContain('Lesson A.')
    expect(layer).not.toContain('Lesson B.')
    expect(layer).toContain('[1 task-experience paragraphs omitted: expired or unverifiable]')
    expect(after?.revision).not.toBe(before?.revision)
  })

  it('a missing or corrupt registry hides every user-level RSI section as unverifiable', async () => {
    const stored = `${HAND}\n${block(A, 'Lesson A.')}\n${block(B, 'Lesson B.')}`
    const missing = renderUserLayer(stored, undefined)
    expect(missing.text).toBe(
      `${HAND.trimEnd()}\n\n[2 task-experience paragraphs omitted: expired or unverifiable]\n`,
    )
    expect(missing.omittedIds).toEqual([A, B])
    const throwing: MemoryValidityView = {
      revision: () => {
        throw new Error('unreadable')
      },
      validity: () => {
        throw new Error('unreadable')
      },
    }
    const f = await fixture({ userValidity: throwing })
    await writeFile(f.userFile, stored)
    const layer = await f.userLayer(1)
    expect(layer).not.toContain('Lesson')
    expect(layer).toContain('- Answer in short sentences.')
  })

  it('duplicate, broken or nested markers are hidden from the agent', () => {
    const { view: v } = view({ [A]: 'valid', [B]: 'valid', [C]: 'valid' })
    const duplicate = `${block(A, 'Twice one.')}${block(A, 'Twice two.')}`
    const broken = `<!-- refinement:${B}\nBroken body.\n<!-- /refinement:${B} -->\n`
    const nested = `<!-- refinement:${C} -->\nOuter.\n${block('rd000000004', 'Inner.')}<!-- /refinement:${C} -->\n`
    const rendered = renderUserLayer(`${HAND}\n${duplicate}${broken}${nested}`, v)
    for (const hidden of ['Twice', 'Broken body', 'Outer', 'Inner', 'refinement'])
      expect(rendered.text).not.toContain(hidden)
    expect(rendered.text.startsWith(HAND.trimEnd())).toBe(true)
    expect(rendered.text).toMatch(/\[\d+ task-experience paragraphs omitted: expired or unverifiable\]\n$/)
  })

  it('RSI sections never displace hand-written user memory within the 512-token budget', async () => {
    const { view: v } = view({ [A]: 'valid' })
    const hand = `${'- A hand-written preference that matters.\n'.repeat(8)}`
    const f = await fixture({ userValidity: v })
    // The saved section comes first in the file and is long: the hand-written text still comes first.
    await writeFile(f.userFile, `${block(A, `Saved: ${'x'.repeat(400)}`)}\n${hand}`)
    const layer = await f.userLayer(1)
    expect(Buffer.byteLength(layer)).toBeLessThanOrEqual(512)
    expect(layer.startsWith(hand.trimEnd())).toBe(true)
    expect(layer).toContain('Memory omitted')
  })

  it('renewal in the registry changes delivery without touching the file', async () => {
    const answers = view({ [A]: 'expired' })
    const f = await fixture({ userValidity: answers.view })
    await writeFile(f.userFile, `${HAND}\n${block(A, 'Lesson A.')}`)
    const stored = await readFile(f.userFile, 'utf8')
    expect(await f.userLayer(1)).not.toContain('Lesson A.')
    answers.set(A, 'valid')
    expect(await f.userLayer(2)).toContain('Lesson A.')
    expect(await readFile(f.userFile, 'utf8')).toBe(stored)
  })

  it('delivered sections are left out of the user layer without a count line', async () => {
    const { view: v } = view({ [A]: 'delivered', [B]: 'valid' })
    const f = await fixture({ userValidity: v })
    await writeFile(f.userFile, `${HAND}\n${block(A, 'Lesson A.')}\n${block(B, 'Lesson B.')}`)
    const layer = await f.userLayer(1)
    expect(layer).toContain('Lesson B.')
    expect(layer).not.toContain('Lesson A.')
    expect(layer).not.toContain('task-experience paragraphs omitted')
    expect(userLayerBytes(`${HAND}\n${block(A, 'Lesson A.')}`, v)).toEqual({
      handWritten: Buffer.byteLength(HAND.trimEnd()),
      rsiInForce: 0,
    })
  })

  it('counts hand-written bytes and the sections in force the way they are shown', () => {
    const { view: v } = view({ [A]: 'valid', [B]: 'expired' })
    const stored = `${HAND}\n${block(A, 'Lesson A.')}\n${block(B, 'Lesson B, long expired.')}`
    expect(userLayerBytes(stored, v)).toEqual({
      handWritten: Buffer.byteLength(HAND.trimEnd()),
      rsiInForce: Buffer.byteLength('\n\nLesson A.'),
    })
    expect(userLayerBytes(HAND, v)).toEqual({ handWritten: Buffer.byteLength(HAND), rsiInForce: 0 })
  })
})

describe('user memory: the managed section write', () => {
  it('passes the paragraph-port conformance checks', async () => {
    const passed = await memoryParagraphConformance(async () => {
      const f = await fixture({ userValidity: view().view })
      await writeFile(f.userFile, 'Human preference.\n')
      return {
        port: f.port(),
        editStored: async () =>
          writeFile(f.userFile, `${await readFile(f.userFile, 'utf8')}Edited by a person.\n`),
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

  it('writeUserSection keeps hand-written bytes and other sections', async () => {
    const answers = view({ [A]: 'valid' })
    const f = await fixture({ userValidity: answers.view })
    const stored = `${HAND}\n${block(A, 'Lesson A.')}`
    await writeFile(f.userFile, stored)
    const listed = await f.port().list()
    expect(listed.paragraphs).toEqual([{ id: A, text: 'Lesson A.', validity: 'valid' }])
    const proposal = await f.port().propose({ op: 'put', id: B, text: 'Lesson B.' }, listed.hash)
    const port = f.port()
    const again = await port.propose({ op: 'put', id: B, text: 'Lesson B.' }, listed.hash)
    expect(again.newHash).toBe(proposal.newHash)
    await port.commit(again)
    expect(await readFile(f.userFile, 'utf8')).toBe(`${stored}\n${block(B, 'Lesson B.')}`)
    const removed = f.port()
    await removed.commit(await removed.propose({ op: 'remove', id: B }))
    expect(await readFile(f.userFile, 'utf8')).toBe(stored)
  })

  it('works while workspace memory is off: the user layer does not depend on it', async () => {
    const f = await fixture({ userValidity: view().view, mode: 'off' })
    await writeFile(f.userFile, HAND)
    const port = f.port()
    await port.commit(await port.propose({ op: 'put', id: A, text: 'Lesson A.' }))
    expect(await readFile(f.userFile, 'utf8')).toBe(`${HAND}\n${block(A, 'Lesson A.')}`)
  })

  it('it refuses to edit hand-written text or a marker', async () => {
    const f = await fixture({ userValidity: view().view })
    await writeFile(f.userFile, HAND)
    await expect(
      f.port().propose({ op: 'put', id: A, text: `x\n<!-- /refinement:${A} -->\ny` }),
    ).rejects.toMatchObject({ code: 'MEMORY_MARKER_CHANGED' })
    await expect(f.port().propose({ op: 'remove', id: A })).rejects.toMatchObject({
      code: 'MEMORY_PARAGRAPH_NOT_FOUND',
    })
    await expect(f.port().propose({ op: 'put', id: 'not-an-id', text: 'x' })).rejects.toMatchObject({
      code: 'MEMORY_PARAGRAPH_INVALID',
    })
    expect(await readFile(f.userFile, 'utf8')).toBe(HAND)
  })

  it('secret-looking content is refused by the same check as workspace memory', async () => {
    const f = await fixture({ userValidity: view().view })
    await writeFile(f.userFile, HAND)
    for (const secret of ['api_key=synthetic-sensitive-key', `token ghp_${'a'.repeat(30)}`])
      await expect(f.port().propose({ op: 'put', id: A, text: secret })).rejects.toMatchObject({
        code: 'MEMORY_SECRET_LIKE_CONTENT',
      })
    expect(await readFile(f.userFile, 'utf8')).toBe(HAND)
  })

  it('a promotion that would push user memory past its budget is refused and writes nothing', async () => {
    const answers = view({ [A]: 'valid', [B]: 'expired' })
    const f = await fixture({ userValidity: answers.view })
    const hand = `${'h'.repeat(300)}\n`
    // An expired section takes no room in what is shown; the one in force does.
    const stored = `${hand}\n${block(A, 'a'.repeat(100))}\n${block(B, 'b'.repeat(400))}`
    await writeFile(f.userFile, stored)
    // 300 + (2 + 100) + (2 + 100) = 504: fits in 512.
    const port = f.port()
    await port.commit(await port.propose({ op: 'put', id: C, text: 'c'.repeat(100) }))
    const fits = await readFile(f.userFile, 'utf8')
    expect(fits).toContain('c'.repeat(100))
    // The Host records it: from now on it is in force.
    answers.set(C, 'valid')
    // One more section of 10 bytes does not.
    await expect(
      f.port().propose({ op: 'put', id: 'rd000000004', text: 'd'.repeat(10) }),
    ).rejects.toMatchObject({ code: 'MEMORY_USER_BUDGET' })
    // A smaller user budget in this workspace's settings is the limit there.
    await f.session.configure({ userTokenBudget: 256 })
    await expect(f.port().propose({ op: 'put', id: C, text: 'c'.repeat(10) })).rejects.toMatchObject({
      code: 'MEMORY_USER_BUDGET',
    })
    // A larger one never raises the limit above 512: every workspace reads the same file.
    await f.session.configure({ userTokenBudget: 4096 })
    await expect(
      f.port().propose({ op: 'put', id: 'rd000000004', text: 'd'.repeat(10) }),
    ).rejects.toMatchObject({ code: 'MEMORY_USER_BUDGET' })
    // Taking a section out always fits.
    const out = f.port()
    await out.commit(await out.propose({ op: 'remove', id: C }))
    expect(await readFile(f.userFile, 'utf8')).toBe(stored)
  })

  it('a section save is not refused for the injection limit when the Host delivers sections itself', async () => {
    const answers = view({ [A]: 'delivered' }, true)
    const f = await fixture({ userValidity: answers.view })
    const hand = `${'h'.repeat(300)}\n`
    const stored = `${hand}\n${block(A, 'a'.repeat(400))}`
    await writeFile(f.userFile, stored)
    // 300 hand-written bytes plus 400 + 100 bytes of sections: well past 512, still written.
    const port = f.port()
    await port.commit(await port.propose({ op: 'put', id: C, text: 'c'.repeat(100) }))
    expect(await readFile(f.userFile, 'utf8')).toContain('c'.repeat(100))
    answers.set(C, 'delivered')
    const layer = await f.userLayer(1)
    expect(layer).toContain(hand.trimEnd())
    expect(layer).not.toContain('a'.repeat(400))
    expect(layer).not.toContain('task-experience paragraphs omitted')
  })

  it('over the index cap it refuses for lack of room, never trimming', async () => {
    const f = await fixture({ userValidity: view().view })
    // Expired or unverifiable sections still take room in the file.
    const stored = Array.from({ length: 60 }, (_, i) =>
      block(`r${String(i).padStart(10, '0')}`, `${'z'.repeat(300)}`),
    ).join('\n')
    await writeFile(f.userFile, stored)
    await expect(f.port().propose({ op: 'put', id: A, text: 'tiny' })).rejects.toMatchObject({
      code: 'MEMORY_USER_BUDGET',
    })
    expect(await readFile(f.userFile, 'utf8')).toBe(stored)
  })

  it('a changed base is re-merged, never overwritten', async () => {
    const f = await fixture({ userValidity: view().view })
    await writeFile(f.userFile, HAND)
    const listed = await f.port().list()
    const port = f.port()
    const proposal = await port.propose({ op: 'put', id: A, text: 'Lesson A.' }, listed.hash)
    // A person edits the file meanwhile: the stale proposal and the stale base are both refused.
    await writeFile(f.userFile, `${HAND}- Added by hand.\n`)
    await expect(port.commit(proposal)).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    await expect(
      f.port().propose({ op: 'put', id: A, text: 'Lesson A.' }, listed.hash),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(await readFile(f.userFile, 'utf8')).toBe(`${HAND}- Added by hand.\n`)
    // Proposed again on the new base, the person's line stays.
    const merged = f.port()
    await merged.commit(await merged.propose({ op: 'put', id: A, text: 'Lesson A.' }))
    expect(await readFile(f.userFile, 'utf8')).toBe(`${HAND}- Added by hand.\n\n${block(A, 'Lesson A.')}`)
  })

  it('the agent still cannot write user memory through its file tools', async () => {
    const f = await fixture({ userValidity: view().view })
    await writeFile(f.userFile, HAND)
    const files = f.session.files(
      {
        read: async () => new Uint8Array(),
        write: async () => undefined,
        list: async () => [],
        stat: async () => ({ size: 0, mtimeMs: 0, kind: 'file' }),
      },
      { sessionKey: 'one', turn: 1 },
      new AbortController().signal,
      async () => ({ status: 'approved' }),
    )
    await expect(files.write(f.userFile, 'agent edit')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
  })
})
