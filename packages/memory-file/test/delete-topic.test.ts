import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryApprovalResult, MemoryFilePort, MemoryProposal } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { hash } from '../src/content.js'
import { unlinkTopic } from '../src/delete-topic.js'
import {
  fileMemoryRoots,
  inspectMemoryConsistency,
  isMemoryPreEffectRefusal,
  openMemory,
  rebuildMemoryIndex,
} from '../src/index.js'
import { MemoryStore } from '../src/store.js'

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
  const { protectedRoot } = fileMemoryRoots(home, home)
  return {
    home,
    fallback,
    session,
    path,
    index,
    source,
    port,
    json,
    store: new MemoryStore(protectedRoot, session.root),
  }
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
  const links = [
    '[link](prefs.md)',
    '[link]( prefs.md )',
    '[link]( ./prefs.md )',
    '[link](prefs.md\n"title")',
    "[link](prefs.md\n'title')",
    '[link](prefs.md\n(title))',
    '> [id]: prefs.md',
    '> > [id]: ./prefs.md',
    '> [id]: <prefs.md>',
    '[link](./prefs.md#x "title")',
    '[link](<prefs.md>)',
    "[link](<./prefs.md#x> 'title')",
    '[[prefs.md]]',
    '[[./prefs.md#section|summary]]',
    '[[./prefs.md|alias]]',
    '[doc]: prefs.md',
    ' [doc]: ./prefs.md',
    '  [doc]: <prefs.md>',
    '   [doc]: <./prefs.md#title>',
  ]
  for (const link of [...links, '\uFEFF   [doc]: <./prefs.md>']) {
    await session.editFile('MEMORY.md', link, (await session.readFile('MEMORY.md')).hash)
    const raw =
      '<!-- refinement:r1234567890 -->\n<!-- expires_at: 2001-01-01 -->\n' +
      link +
      '\n<!-- /refinement:r1234567890 -->'
    await writeFile(index, link.startsWith('\uFEFF') ? link : raw)
    await expect(session.deleteFile!('prefs.md', before.hash)).rejects.toMatchObject({
      code: 'MEMORY_TOPIC_REFERENCED',
    })
    expect(await readFile(index, 'utf8')).toContain(link)
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

it('uses file identity for differently cased index links', async () => {
  const { session, path, index } = await setup()
  await writeFile(path, 'first')
  const alternate = join(session.root, 'Prefs.md')
  await writeFile(index, '[[Prefs.md]]')
  if (existsSync(alternate)) {
    await expect(session.deleteFile!('prefs.md', hash('first'))).rejects.toMatchObject({
      code: 'MEMORY_TOPIC_REFERENCED',
    })
  } else {
    await writeFile(alternate, 'distinct')
    await session.deleteFile!('prefs.md', hash('first'))
    expect(await readFile(alternate, 'utf8')).toBe('distinct')
  }
})

it('restores a raced replacement on mismatch without changing provenance', async () => {
  const { session, path, port, json } = await setup()
  await port().write(path, 'original')
  const prior = await json('meta/provenance.json')
  const atomic = MemoryStore.prototype.atomic
  vi.spyOn(MemoryStore.prototype, 'atomic').mockImplementation(function (
    this: MemoryStore,
    target,
    content,
    verify,
  ) {
    atomic.call(this, target, content, verify)
    if (target.endsWith('delete-intent.json')) writeFileSync(path, 'replacement')
  })
  await expect(session.deleteFile!('prefs.md', hash('original'))).rejects.toMatchObject({
    code: 'MEMORY_CONFLICT',
  })
  expect(await readFile(path, 'utf8')).toBe('replacement')
  expect(await json('meta/provenance.json')).toEqual(prior)
  expect((await readdir(session.root)).filter((n) => n.endsWith('.del.tmp'))).toEqual([])
  await expect(port(2).remove!('prefs.md')).rejects.toMatchObject({ code: 'MEMORY_HUMAN_EDITED' })
})

it.each(['missing', 'reclaimed', 'restoring'])(
  'recovers an interrupted move on the next read (%s)',
  async (state) => {
    const reclaimed = state === 'reclaimed'
    const { session, path } = await setup()
    const id = randomUUID()
    const tombstone = `${path}.${id}.del.tmp`
    const intent = join(session.root, 'delete-intent.json')
    await writeFile(path, 'original')
    await writeFile(intent, JSON.stringify({ path: 'prefs.md', id }))
    await rename(path, tombstone)
    if (reclaimed) await writeFile(path, 'reclaimed')
    if (state === 'restoring') await link(tombstone, path)
    expect((await session.readFile('prefs.md')).content).toBe(reclaimed ? 'reclaimed' : 'original')
    expect(existsSync(intent)).toBe(false)
    if (reclaimed) expect(await readFile(tombstone, 'utf8')).toBe('original')
    else expect(existsSync(tombstone)).toBe(false)
  },
)

it('keeps existing and fresh session reads available while an approved removal rolls back', async () => {
  const { session, path, port, home, source, fallback } = await setup()
  const second = openMemory({ home, workspaceRoot: home, sessionKey: 'second' })
  cleanup.unshift(async () => {
    await second.close?.()
  })
  const fresh = second.files(
    fallback,
    { ...source, sessionKey: 'second' },
    new AbortController().signal,
    async () => ({ status: 'rejected' }),
  )
  let freshRead: Promise<Uint8Array> | undefined
  const reader = port()
  await reader.write(path, 'original')
  await session.configure({ mode: 'ask' })
  const cancellation = new Error('approval withdrawn')
  let during: Promise<Uint8Array> | undefined
  const deletePort = port(1, async () => ({
    status: 'approved',
    admission: {
      async verify() {},
      assertActive() {
        if (!existsSync(path)) {
          during = reader.read(path)
          freshRead = fresh.read(path)
          throw cancellation
        }
      },
    },
  }))
  await expect(deletePort.remove!(path)).rejects.toBe(cancellation)
  expect((await during)?.toString()).toBe('original')
  expect((await freshRead)?.toString()).toBe('original')
  expect((await fresh.read(path)).toString()).toBe('original')
  expect(await readFile(path, 'utf8')).toBe('original')
  expect((await reader.read(path)).toString()).toBe('original')
})

it.each(['mutation', 'deadline'])('rechecks a %s during provenance pruning', async (race) => {
  const { session, path, port } = await setup()
  await port().write(path, 'original')
  await session.configure({ mode: 'ask' })
  const { permissionEffectAdmission } = await import('@agnes/protocol')
  let now = 0
  const revoked = Error('approval expired')
  const admission = permissionEffectAdmission({
    expiresAt: 10,
    clock: () => now,
    signals: [],
    unavailable: () => revoked,
    assertBound() {},
  })
  const descriptor = await open(path, 'r+')
  try {
    const atomic = MemoryStore.prototype.atomic
    vi.spyOn(MemoryStore.prototype, 'atomic').mockImplementation(function (
      this: MemoryStore,
      target,
      content,
      verify,
    ) {
      atomic.call(this, target, content, verify)
      if (target.endsWith('provenance.json')) {
        if (race === 'mutation') writeFileSync(descriptor.fd, 'modified')
        else now = 11
      }
    })
    const deletion = port(2, async () => ({ status: 'approved', admission })).remove!(path)
    if (race === 'mutation') await expect(deletion).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    else await expect(deletion).rejects.toBe(revoked)
    expect(await readFile(path, 'utf8')).toBe(race === 'mutation' ? 'modified' : 'original')
    expect(existsSync(join(session.root, 'delete-intent.json'))).toBe(false)
  } finally {
    await descriptor.close()
  }
})

it.each(['moved', 'unlinked'])('replays %s intent after unlink exactly once', async (phase) => {
  const { session, path, json, source } = await setup()
  const before = await session.editFile('prefs.md', 'former', hash(''))
  expect((await inspectMemoryConsistency(session, 1)).indexIds).not.toEqual([])
  const intent = join(session.root, 'delete-intent.json')
  const journal = JSON.stringify({
    phase,
    leaf: before.path,
    tombstone: `${before.path}.${randomUUID()}.del.tmp`,
    baseHash: before.hash,
    origin: 'human',
    actor: 'owner',
    source,
  })
  await rm(path)
  for (let attempt = 0; attempt < 2; attempt++) {
    await writeFile(intent, journal)
    await session.readFile('prefs.md')
    expect(existsSync(intent)).toBe(false)
    expect((await json('acknowledged.json')).files).toEqual({})
    expect((await json('meta/provenance.json')).files).toEqual({})
    expect(await json('writer.json')).toEqual(source)
    expect((await inspectMemoryConsistency(session, 2)).indexIds).toEqual([])
  }
  const log = (await readFile(join(session.root, 'meta/audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(log.filter((entry) => entry.action === 'delete')).toEqual([
    expect.objectContaining({ path: before.path, beforeHash: before.hash, actor: 'owner' }),
  ])
})

it('retries a busy tombstone verification before committing', async () => {
  const { path, store } = await setup()
  await writeFile(path, 'original')
  let busy = true
  await store.locked(() =>
    unlinkTopic(
      store,
      'prefs.md',
      {
        baseHash: hash('original'),
        origin: 'human',
        actor: 'owner',
        source: { sessionKey: 'work', turn: 0 },
      },
      () => {
        if (busy) {
          busy = false
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
        return true
      },
      () => {},
      () => {},
    ),
  )
  expect(existsSync(path)).toBe(false)
})

it('rejects a non-Markdown symlink to an agent-authored topic', async ({ skip }) => {
  const { session, path, port } = await setup()
  await port().write(path, 'original')
  const alias = join(session.root, 'alias')
  try {
    await symlink(path, alias)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return skip()
    throw error
  }
  await expect(port().remove!(alias)).rejects.toMatchObject({ code: 'MEMORY_SCOPE_DENIED' })
  expect(await readFile(path, 'utf8')).toBe('original')
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
  const journal = join(session.root, 'delete-intent.json')
  expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({
    phase: 'unlinked',
    origin: 'agent',
    actor: 'agent:work:test',
    source,
  })
  await rm(writer, { recursive: true })
  expect((await session.readFile('prefs.md')).content).toBe('recreated')
  expect(existsSync(journal)).toBe(false)
  const audit = (await readFile(join(session.root, 'meta/audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(audit.filter((entry) => entry.action === 'delete')).toHaveLength(1)
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

it('allows turning memory off while committed-deletion audit metadata is blocked and preserves the intent', async () => {
  const { session, path } = await setup()
  const saved = await session.editFile('prefs.md', 'topic body', hash(''))
  const auditPath = join(session.root, 'meta', 'audit.jsonl')
  await rm(auditPath, { force: true })
  await mkdir(auditPath)
  await expect(session.deleteFile!('prefs.md', saved.hash)).rejects.toMatchObject({
    code: 'MEMORY_COMMITTED_METADATA_FAILED',
  })
  const journal = join(session.root, 'delete-intent.json')
  expect(existsSync(journal)).toBe(true)
  const inspected = await session.configure({ mode: 'off' })
  expect(inspected.settings.mode).toBe('off')
  expect(existsSync(journal)).toBe(true)
  await rm(auditPath, { recursive: true })
  expect((await session.inspect()).files).toEqual([])
  expect(existsSync(journal)).toBe(false)
  const audit = (await readFile(auditPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(audit.filter((entry) => entry.action === 'delete' && entry.path === 'prefs.md')).toHaveLength(1)
  expect(existsSync(path)).toBe(false)
})

it('reconciles a verified post-unlink intent even when the topic name is recreated before recovery', async () => {
  const { session, path } = await setup()
  const saved = await session.editFile('prefs.md', 'old topic', hash(''))
  await rm(path)
  await writeFile(path, 'recreated independently')
  const journal = join(session.root, 'delete-intent.json')
  await writeFile(
    journal,
    JSON.stringify({
      leaf: 'prefs.md',
      tombstone: 'prefs.md.12345678-1234-1234-1234-123456789abc.del.tmp',
      baseHash: saved.hash,
      origin: 'human',
      actor: 'human',
      source: { sessionKey: 'work', turn: 0 },
      phase: 'verified',
    }),
  )
  expect((await session.readFile('prefs.md')).content).toBe('recreated independently')
  expect(existsSync(journal)).toBe(false)
  const ack = JSON.parse(await readFile(join(session.root, 'acknowledged.json'), 'utf8')) as {
    files: Record<string, string>
  }
  expect(ack.files['prefs.md']).toBeUndefined()
  const audit = (await readFile(join(session.root, 'meta', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(audit.filter((entry) => entry.action === 'delete' && entry.beforeHash === saved.hash)).toHaveLength(
    1,
  )
})

it.each(['[label](prefs.md "line one\nline two")', '>\t[ref]: prefs.md\n\n[label][ref]'])(
  'blocks deletion for multiline title and tab-blockquote links: %s',
  async (indexBody) => {
    const { session } = await setup()
    const topic = await session.editFile('prefs.md', 'referenced body', hash(''))
    await session.editFile('MEMORY.md', indexBody, hash(''))
    await expect(session.deleteFile!('prefs.md', topic.hash)).rejects.toMatchObject({
      code: 'MEMORY_TOPIC_REFERENCED',
    })
  },
)
