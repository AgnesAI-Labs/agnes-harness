import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryApprovalResult, MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { hash } from '../src/content.js'
import {
  inspectMemoryConsistency,
  isMemoryPreEffectRefusal,
  openMemory,
  rebuildMemoryIndex,
} from '../src/index.js'
import { MetaStore } from '../src/meta.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const clean of cleanup.splice(0)) await clean()
})
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'agh-delete-topic-'))
  const session = openMemory({ home, workspaceRoot: home, sessionKey: 'work' })
  cleanup.push(async () => {
    await session.close?.()
    await rm(home, { recursive: true, force: true })
  })
  await session.configure({ mode: 'auto' })
  const outside = async (): Promise<never> => {
    throw new Error('unexpected fallback')
  }
  const fallback: MemoryFilePort = {
    read: outside,
    write: outside,
    stat: outside,
    list: outside,
    remove: outside,
  }
  const source = { sessionKey: 'work', turn: 1, toolUseId: 'test' }
  const port = (
    turn = 1,
    approve: (p: MemoryProposal) => Promise<MemoryApprovalResult> = async () => ({ status: 'approved' }),
  ) => session.files(fallback, { ...source, turn }, new AbortController().signal, approve)
  const path = join(session.root, 'prefs.md')
  const index = join(session.root, 'MEMORY.md')
  const json = async (name: string) => JSON.parse(await readFile(join(session.root, name), 'utf8'))
  return { session, path, index, source, port, json }
}

it('deletes an empty file with exact CAS, records its owner and preserves other acknowledgements', async () => {
  const { session, json, path } = await setup()
  const empty = hash('')
  const remove = session.deleteFile!
  await expect(remove('prefs.md', empty)).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' })
  for (const leaf of ['MEMORY.md', 'Memory.md', 'memory.md', '../outside.md'])
    await expect(remove(leaf, empty)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
  await session.editFile('other.md', 'untouched', empty)
  await session.editFile('prefs.md', '', empty)
  await expect(remove('prefs.md', hash('stale'))).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
  expect(existsSync(path)).toBe(true)
  await remove('prefs.md', empty, { actor: ' owner ' })
  expect(existsSync(path)).toBe(false)
  expect((await json('acknowledged.json')).files).toEqual({ 'other.md': hash('untouched') })
  expect((await json('meta/provenance.json')).files).not.toHaveProperty('prefs.md')
  expect((await session.snapshot(2))?.externalChanges).toBeUndefined()
  const audit = (await readFile(join(session.root, 'meta/audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .at(-1)
  expect(audit).toMatchObject({
    action: 'delete',
    path: 'prefs.md',
    actor: 'owner',
    origin: 'human',
    beforeHash: empty,
    afterHash: hash('delete:' + empty),
  })
})

it('checks inline, wiki and reference links in the raw index, including hidden and managed text', async () => {
  const { session, index } = await setup()
  const before = await session.editFile('prefs.md', 'body', hash(''))
  for (const link of ['[link](PREFS.MD#x "title")', '[[pREFs.md#section]]', '[doc]: Prefs.md#title']) {
    const raw =
      '<!-- refinement:r1234567890 -->\n<!-- expires_at: 2001-01-01 -->\n' +
      link +
      '\n<!-- /refinement:r1234567890 -->'
    await writeFile(index, raw)
    await expect(session.deleteFile!('prefs.md', before.hash)).rejects.toMatchObject({
      code: 'MEMORY_TOPIC_REFERENCED',
    })
    expect(await readFile(index, 'utf8')).toBe(raw)
  }
})

it('permits owner deletion and index reconciliation while the store is over the file limit', async () => {
  const { session, path } = await setup()
  await Promise.all(
    Array.from({ length: 129 }, (_, i) => writeFile(join(session.root, `topic${i}.md`), 'body')),
  )
  await writeFile(path, 'body')
  await session.deleteFile!('prefs.md', hash('body'))
  expect(existsSync(path)).toBe(false)
  expect((await readdir(session.root)).filter((n) => n.endsWith('.md'))).toHaveLength(129)
})

it('restores a raced replacement when the tombstone hash differs, with prior attribution already removed', async () => {
  const { session, path, port } = await setup()
  await port().write(path, 'original')
  const write = MetaStore.prototype.writeJson
  vi.spyOn(MetaStore.prototype, 'writeJson').mockImplementation(function (
    this: MetaStore,
    filename,
    value,
    verify,
  ) {
    write.call(this, filename, value, verify)
    if (filename === 'provenance.json') {
      expect(JSON.parse(readFileSync(this.pathOf(filename), 'utf8')).files).not.toHaveProperty('prefs.md')
      writeFileSync(path, 'replacement')
    }
  })
  await expect(session.deleteFile!('prefs.md', hash('original'))).rejects.toMatchObject({
    code: 'MEMORY_CONFLICT',
  })
  expect(await readFile(path, 'utf8')).toBe('replacement')
  expect((await readdir(session.root)).filter((n) => n.endsWith('.del.tmp'))).toEqual([])
  await expect(port(2).remove!('prefs.md')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
})

it.each(['flat', 'absolute'])(
  'binds %s deletion to approval, withdraws its same-turn view, and reconciles FTS',
  async (spelling) => {
    const { session, path, port } = await setup()
    await port().write(path, 'quartz preference')
    await session.configure({ mode: 'ask' })
    const approve = vi.fn(async (_proposal: MemoryProposal) => ({ status: 'approved' as const }))
    const p = port(2, approve)
    expect((await p.recall!({ query: 'quartz' })).hits.length).toBeGreaterThan(0)
    await p.remove!(spelling === 'flat' ? 'prefs.md' : path)
    const before = hash('quartz preference')
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        path,
        operation: 'delete',
        baseHash: before,
        newHash: hash('delete:' + before),
      }),
    )
    expect((await inspectMemoryConsistency(session, 2)).indexIds).toEqual([])
    expect(await rebuildMemoryIndex(session)).toEqual({ indexedEntries: 0 })
    await writeFile(path, 'quartz recreated')
    await expect(p.read(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await p.list(session.root)).toEqual([])
    expect((await p.recall!({ query: 'quartz' })).hits).toEqual([])
    expect((await port(3).read(path)).toString()).toBe('quartz recreated')
  },
)

it.each([
  ['', 'MEMORY_HUMAN_EDITED'],
  [' \n\t', 'MEMORY_HUMAN_EDITED'],
  ['manual', 'MEMORY_HUMAN_EDITED'],
  ['<!-- refinement:bad -->\nmarker', 'MEMORY_MARKER_CHANGED'],
  ['<!-- expires_at: 2000-01-01 -->\nhidden', 'MEMORY_HIDDEN_PARAGRAPHS'],
])('refuses protected topic %j before asking', async (content, code) => {
  const { session, port, path, source } = await setup()
  await writeFile(path, content)
  await session.configure({ mode: 'ask' })
  const approve = vi.fn(async () => ({ status: 'approved' as const }))
  const failure = await port(1, approve).remove!('prefs.md').catch((e) => e)
  expect(failure).toMatchObject({ code })
  expect(isMemoryPreEffectRefusal(failure, source)).toBe(true)
  expect(approve).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(content)
})

it('attests missing, out-of-scope, mid-turn creation and concurrently added index links', async () => {
  const { session, port, path, index, source } = await setup()
  const p = port()
  await session.snapshot(1)
  for (const [leaf, code] of [
    ['missing.md', 'MEMORY_NOT_FOUND'],
    ['mEmOrY.md', 'MEMORY_SCOPE_DENIED'],
    [join(session.root, '..', 'outside.md'), 'MEMORY_SCOPE_DENIED'],
  ]) {
    const err = await p.remove!(leaf!).catch((e) => e)
    expect(err).toMatchObject({ code })
    expect(isMemoryPreEffectRefusal(err, source)).toBe(true)
  }
  await writeFile(path, 'external')
  await expect(p.remove!(path)).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
  await rm(path)
  await p.write(path, 'agent')
  await session.configure({ mode: 'ask' })
  const err = await port(1, async () => {
    await session.editFile('MEMORY.md', '[[prefs.md]]', hash(''))
    return { status: 'approved' }
  }).remove!(path).catch((e) => e)
  expect(err).toMatchObject({ code: 'MEMORY_TOPIC_REFERENCED' })
  expect(isMemoryPreEffectRefusal(err, source)).toBe(true)
  expect(await readFile(index, 'utf8')).toBe('[[prefs.md]]')
  expect(await readFile(path, 'utf8')).toBe('agent')
})

it('withdraws a committed deletion when writer metadata fails and supplies no pre-effect proof', async () => {
  const { session, path, port, source } = await setup()
  const p = port()
  await p.write(path, 'entry')
  const writer = join(session.root, 'writer.json')
  await rm(writer)
  await mkdir(writer)
  const err = await p.remove!(path).catch((e) => e)
  expect(err).toMatchObject({ code: 'MEMORY_COMMITTED_METADATA_FAILED' })
  expect(isMemoryPreEffectRefusal(err, source)).toBe(false)
  await writeFile(path, 'recreated')
  await expect(p.read(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await p.list(session.root)).toEqual([])
})

it.each([
  ['off', 'MEMORY_DISABLED'],
  ['auto', 'MEMORY_POLICY_CHANGED'],
] as const)('refuses an approved deletion after policy changes to %s', async (mode, code) => {
  const { session, path, port, source } = await setup()
  await port().write(path, 'agent topic')
  await session.configure({ mode: 'ask' })
  const p = port(1, async () => {
    await session.configure({ mode })
    return { status: 'approved' }
  })
  const error = await p.remove!(path).catch((e) => e)
  expect(error).toMatchObject({ code })
  expect(isMemoryPreEffectRefusal(error, source)).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('agent topic')
})
