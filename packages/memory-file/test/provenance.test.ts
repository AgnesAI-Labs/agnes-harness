import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryFilePort, MemorySession } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { hash } from '../src/content.js'
import { createDefaultPipeline, fileMemoryRoots, openMemory } from '../src/index.js'
import { registerMemoryProtection } from '../src/preference-conflict.js'
import { memoryBlocks } from '../src/provenance.js'

const id = 'r1234567890'
const managed = (body: string) => `<!-- refinement:${id} -->\n${body}\n<!-- /refinement:${id} -->`
const sessions: MemorySession[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close?.()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const outside = async (): Promise<never> => {
  throw new Error('unexpected fallback')
}
const fallback: MemoryFilePort = { read: outside, write: outside, list: outside, stat: outside }

async function setup(mode: 'ask' | 'auto' = 'auto', answer: 'approved' | 'rejected' = 'approved') {
  const home = await mkdtemp(join(tmpdir(), 'agh-protection-'))
  homes.push(home)
  const pipeline = createDefaultPipeline()
  registerMemoryProtection(pipeline)
  const session = openMemory({ home, workspaceRoot: home, sessionKey: 's', pipeline })
  sessions.push(session)
  await session.configure({ mode })
  const approve = vi.fn(async () =>
    answer === 'approved' ? { status: 'approved' as const } : { status: 'rejected' as const },
  )
  const signal = new AbortController().signal
  let turn = 0
  const index = join(session.root, 'MEMORY.md')
  const agent = (text: string, path = index) =>
    session
      .files(fallback, { sessionKey: 's', turn: ++turn, toolUseId: 't' }, signal, approve)
      .write(path, text)
  const human = async (text: string) =>
    session.editFile('MEMORY.md', text, (await session.readFile('MEMORY.md')).hash)
  const paragraphs = session.paragraphs?.({ sessionKey: 's', turn: 0 }, signal)
  if (!paragraphs) throw new Error('Missing paragraph port')
  const provenance = join(session.root, 'meta', 'provenance.json')
  return { home, session, index, agent, human, approve, paragraphs, provenance }
}

it('splits ordinary blocks around well-formed paragraphs and keeps damaged markers in ordinary text', () => {
  const text = `Mixed  CASE\n wrapped\n \n${managed('a\n\nb')}\n<!-- refinement:bad -->\nbody`
  const blocks = memoryBlocks(text)
  expect(blocks).toHaveLength(3)
  expect(blocks[0]?.blockHash).toBe(hash('mixed case wrapped'))
  expect(blocks[1]).toMatchObject({
    id,
    blockHash: `managed:${id}`,
    text: 'a\n\nb',
    textHash: hash('a\n\nb'),
  })
  expect(blocks[2]?.blockHash).toBe(hash('<!-- refinement:bad --> body'))
})

it('retains unchanged origins across all three writers and isolates provenance by file', async () => {
  const f = await setup()
  await f.agent('Agent note')
  await f.human('Agent note\n\nManual note')
  await f.paragraphs.commit(await f.paragraphs.propose({ op: 'put', id, text: 'Host note' }))
  await f.agent('Manual note', join(f.session.root, 'topic.md'))
  expect(JSON.parse(await readFile(f.provenance, 'utf8'))).toMatchObject({
    version: 1,
    files: {
      'MEMORY.md': {
        blocks: [
          { origin: 'agent', blockHash: hash('agent note') },
          { origin: 'human', blockHash: hash('manual note') },
          { origin: 'host', id, textHash: hash('Host note') },
        ],
      },
      'topic.md': { blocks: [{ origin: 'agent', blockHash: hash('manual note') }] },
    },
  })
})

it.each([
  ['auto', 'approved'],
  ['ask', 'approved'],
  ['auto', 'rejected'],
  ['ask', 'rejected'],
] as const)('refuses overwriting human text before approval in %s (%s)', async (mode, answer) => {
  const f = await setup(mode, answer)
  await f.human('deploy_target = staging')
  await expect(f.agent('deploy_target = production')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
  expect(f.approve).toHaveBeenCalledTimes(0)
  expect(await readFile(f.index, 'utf8')).toBe('deploy_target = staging')
  const audit = await readFile(join(f.session.root, 'meta', 'audit.jsonl'), 'utf8')
  expect(JSON.parse(audit.trimEnd().split('\n').at(-1) ?? '')).toMatchObject({
    action: 'refused',
    origin: 'agent',
    code: 'MEMORY_HUMAN_EDITED',
    path: 'MEMORY.md',
  })
  expect(audit).not.toContain('staging')
})

it.each(['missing', 'broken JSON', 'broken schema', 'external edit'])(
  'protects unknown blocks after %s and still permits a separate new block',
  async (damage) => {
    const f = await setup()
    await f.agent('First note')
    if (damage === 'missing') await rm(f.provenance)
    if (damage === 'broken JSON') await writeFile(f.provenance, '{')
    if (damage === 'broken schema')
      await writeFile(f.provenance, '{"version":1,"files":{"MEMORY.md":{"blocks":[null]}}}')
    if (damage === 'external edit') await writeFile(f.index, 'FIRST NOTE')
    const before = await readFile(f.index, 'utf8')
    await expect(f.agent('')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
    await f.agent(`${before}\n\nAgent addition`)
    await f.agent(`${before}\n\nRevised addition`)
    await expect(f.agent('Revised addition')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
    expect(await readFile(f.index, 'utf8')).toBe(`${before}\n\nRevised addition`)
  },
)

it('compares new structured preferences across workspace files and enabled handwritten user values', async () => {
  const f = await setup()
  await f.human('Preference: test_RUNNER = Jest')
  const put = (text: string) => f.paragraphs.propose({ op: 'put', id, text })
  await expect(put('- test_runner: vitest')).rejects.toMatchObject({ code: 'MEMORY_PREFERENCE_CONFLICT' })
  await expect(f.agent('test_runner = vitest', join(f.session.root, 'topic.md'))).rejects.toMatchObject({
    code: 'MEMORY_PREFERENCE_CONFLICT',
  })
  await f.session.editFile('topic.md', 'coverage_tool = c8', hash(''))
  await expect(put('coverage_tool = nyc')).rejects.toMatchObject({ code: 'MEMORY_PREFERENCE_CONFLICT' })
  const user = fileMemoryRoots(f.home, f.home).userRoot
  await mkdir(user, { recursive: true })
  await writeFile(join(user, 'MEMORY.md'), `tab_width = 4\n\n${managed('- style: concise')}`)
  const candidate = 'Preference: test_RUNNER = Jest\n\n- TAB_WIDTH: 2'
  await f.agent(candidate)
  await f.session.configure({ userEnabled: true })
  await f.agent(`${candidate}\n\nExisting disagreement may remain.`)
  await expect(f.agent(candidate.replace('TAB_WIDTH: 2', 'TAB_WIDTH: 8'))).rejects.toMatchObject({
    code: 'MEMORY_PREFERENCE_CONFLICT',
  })
  await expect(put('pReFeReNcE: tab_WIDTH = 2')).rejects.toMatchObject({ code: 'MEMORY_PREFERENCE_CONFLICT' })
  const pending = await put('output_format = markdown')
  await writeFile(join(user, 'MEMORY.md'), 'output_format = plain')
  await expect(f.paragraphs.commit(pending)).rejects.toMatchObject({ code: 'MEMORY_PREFERENCE_CONFLICT' })
  expect(await readFile(f.index, 'utf8')).not.toContain('output_format')
  await expect(put('- test_runner: JEST\nstyle = verbose\nI prefer two spaces.')).resolves.toBeDefined()
  await f.human('tab_width = 2')
})

it('preserves human ownership after a matching put on an externally edited recorded id', async () => {
  const f = await setup()
  const change = { op: 'put' as const, id, text: 'Use pnpm' }
  await f.paragraphs.commit(await f.paragraphs.propose(change))
  await writeFile(f.index, managed('Use PNPM'))
  const expectTextHash = hash('Use PNPM')
  const rewrite = () => f.paragraphs.propose({ ...change, text: 'Use npm', expectTextHash })
  await expect(rewrite()).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_EDITED' })
  await f.paragraphs.commit(await f.paragraphs.propose({ ...change, text: 'Use PNPM', expectTextHash }))
  expect(JSON.parse(await readFile(f.provenance, 'utf8')).files['MEMORY.md'].blocks).toMatchObject([
    { id, origin: 'human', textHash: expectTextHash },
  ])
  await expect(rewrite()).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_EDITED' })
})

it.each(['Legacy note', 'Updated note'])(
  'upgrades an unrecorded managed paragraph after a verified Host put of "%s"',
  async (text) => {
    const f = await setup()
    await writeFile(f.index, managed('Legacy note'))
    await expect(readFile(f.provenance)).rejects.toMatchObject({ code: 'ENOENT' })
    const change = { op: 'put' as const, id, text }
    await expect(f.paragraphs.propose(change)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_EDITED' })
    await expect(f.paragraphs.propose({ ...change, expectTextHash: hash('Other') })).rejects.toMatchObject({
      code: 'MEMORY_PARAGRAPH_EDITED',
    })
    await f.paragraphs.commit(await f.paragraphs.propose({ ...change, expectTextHash: hash('Legacy note') }))
    expect(JSON.parse(await readFile(f.provenance, 'utf8')).files['MEMORY.md'].blocks).toMatchObject([
      { id, origin: 'host', textHash: hash(text) },
    ])
    await f.human(managed('Human revision'))
    await expect(
      f.paragraphs.propose({ ...change, expectTextHash: hash('Human revision') }),
    ).rejects.toMatchObject({
      code: 'MEMORY_PARAGRAPH_EDITED',
    })
  },
)

it.each(['workspace', 'user'] as const)(
  'hides saved projection for an invalid %s index while retaining its stored rows',
  async (layer) => {
    const f = await setup()
    const user = fileMemoryRoots(f.home, f.home).userRoot
    await mkdir(user, { recursive: true })
    const path = layer === 'workspace' ? f.index : join(user, 'MEMORY.md')
    const port =
      layer === 'workspace'
        ? f.paragraphs
        : f.session.userParagraphs?.({ sessionKey: 'reader', turn: 0 }, new AbortController().signal)
    if (!port) throw new Error('missing paragraph port')
    await writeFile(path, 'Intro.\n\n' + managed('Visible'))
    const listing = async () => (await port.list()).paragraphs
    expect(await listing()).toMatchObject([{ id, visibleText: 'Visible' }])
    for (const config of [{ indexMaxLines: 1 }, { indexMaxLines: 200, indexMaxBytes: 16 }]) {
      await f.session.configure(config)
      expect(await listing()).toMatchObject([{ id, text: 'Visible', visibleText: null }])
    }
    await f.session.configure({ indexMaxBytes: 16000 })
    await writeFile(path, 'api_key=synthetic-sensitive-key\n\n' + managed('Visible'))
    expect(await listing()).toMatchObject([{ id, text: 'Visible', visibleText: null }])
  },
)

it('uses user-layer markers for origin and requires an explicit CAS for an existing user section', async () => {
  const f = await setup()
  const user = fileMemoryRoots(f.home, f.home).userRoot
  await mkdir(user, { recursive: true })
  await writeFile(join(user, 'MEMORY.md'), `Human note\r\n\r\n${managed('Old section')}`)
  const port = f.session.userParagraphs?.({ sessionKey: 's', turn: 0 }, new AbortController().signal)
  if (!port) throw new Error('Missing user paragraph port')
  const change = { op: 'put' as const, id, text: 'New section' }
  await expect(port.propose(change)).rejects.toMatchObject({ code: 'MEMORY_PARAGRAPH_EDITED' })
  await port.commit(await port.propose({ ...change, expectTextHash: hash('Old section') }))
  expect(await readFile(join(user, 'MEMORY.md'), 'utf8')).toBe(`Human note\r\n\r\n${managed('New section')}`)
  await expect(readFile(join(user, 'meta', 'provenance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses an oversized provenance update before publication and preserves existing ownership', async () => {
  const f = await setup()
  await f.agent('First note')
  const topic = 'large.md'
  const text = 'a\n\n'.repeat(3000)
  await expect(f.session.editFile(topic, text, hash(''))).rejects.toMatchObject({
    code: 'MEMORY_CONSOLIDATION_REQUIRED',
  })
  expect((await f.session.readFile(topic)).content).toBe('')
  await expect(f.agent(text, join(f.session.root, topic))).rejects.toMatchObject({
    code: 'MEMORY_CONSOLIDATION_REQUIRED',
  })
  await f.agent('Revised agent note')

  // The replacement topic fits by itself once the owner removes the old file.
  const notes = 'a\n\n'.repeat(1500)
  const original = join(f.session.root, 'original.md')
  await f.agent(notes, original)
  await rm(original)
  await f.agent(notes, join(f.session.root, 'replacement.md'))
  expect(Object.keys(JSON.parse(await readFile(f.provenance, 'utf8')).files)).not.toContain('original.md')
})

it('retains the origins of equal copies and protects the last human copy when one disappears', async () => {
  const f = await setup()
  await f.agent('same')
  await f.human('same\n\nsame')
  await f.agent('same\n\nsame\n\nother')
  expect(JSON.parse(await readFile(f.provenance, 'utf8')).files['MEMORY.md'].blocks).toMatchObject([
    { origin: 'agent' },
    { origin: 'human' },
    { origin: 'agent' },
  ])
  await f.agent('same')
  await expect(f.agent('')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
})
