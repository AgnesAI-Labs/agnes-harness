import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryApprovalResult, MemoryFile, MemoryParagraphValidity } from '@agnes/extension-api'
import { afterEach, expect, it } from 'vitest'
import {
  buildIndexView,
  formatLifecycleOmission,
  inspectConsistency,
  rebuildConsistencyIndex,
  registerLifecycle,
} from '../src/consistency.js'
import {
  buildView,
  createDefaultPipeline,
  type MemoryView,
  mapViewSpanToRawLines,
  openMemory,
  type RecallEnvironment,
} from '../src/index.js'

const index = 'MEMORY.md'
const t0 = Date.parse('2027-01-01T00:00:00Z')
const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function chunkView(file: MemoryFile, view: MemoryView) {
  return view.segments.flatMap(({ view: start, raw, length }) => {
    if (raw === undefined || !length) return []
    const lines = mapViewSpanToRawLines(file.content, view, start, start + length)!
    return [{ path: file.path, ...lines, text: view.content.slice(start, start + length) }]
  })
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agh-lifecycle-'))
  homes.push(home)
  const state = { now: t0, revision: 0 }
  const statuses = new Map<string, MemoryParagraphValidity>()
  const validity = (id: string) => statuses.get(id) ?? 'unknown'
  const pipeline = createDefaultPipeline()
  registerLifecycle(pipeline)
  let resolved: RecallEnvironment
  pipeline.setRecall(async ({ query }, env) => {
    resolved = env
    const hits = env.workspaceFiles
      .flatMap((file) => chunkView(file, env.workspaceViews.get(file.path)!))
      .filter((chunk) => chunk.text.includes(query))
      .map((chunk) => ({ ...chunk, layer: 'workspace' as const, score: 1 }))
    return { hits, revision: env.revision, truncated: false }
  })
  const session = openMemory({
    home,
    workspaceRoot: home,
    sessionKey: 'writer',
    clock: () => state.now,
    pipeline,
    validity: { revision: () => String(state.revision), validity },
  })
  await session.configure({ mode: 'auto' })
  const outside = async (): Promise<never> => {
    throw new Error('outside memory')
  }
  const files = (
    turn: number,
    approve: () => Promise<MemoryApprovalResult> = async () => ({ status: 'approved' }),
  ) =>
    session.files(
      { read: outside, write: outside, list: outside, stat: outside },
      { sessionKey: 'writer', turn },
      new AbortController().signal,
      approve,
    )
  const path = (leaf: string) => join(session.root, leaf)
  const read = async (turn: number, leaf = index) =>
    Buffer.from(await files(turn).read(path(leaf))).toString()
  const edit = async (leaf: string, text: string) =>
    session.editFile(leaf, text, (await session.readFile(leaf)).hash)
  const note = async (turn: number) => (await session.snapshot(turn))!.content
  const recall = (turn: number, query: string) => files(turn).recall!({ query })
  const environment = async (turn: number) => {
    await recall(turn, '')
    return resolved
  }
  return {
    home,
    state,
    statuses,
    validity,
    session,
    pipeline,
    files,
    path,
    read,
    edit,
    note,
    recall,
    environment,
  }
}

it('expires ordinary paragraphs at the boundary during a turn and fails closed on malformed dates', async () => {
  const f = await fixture()
  const raw = [
    '<!-- expires_at: 2027-01-01T01:00:01+01:00 -->',
    'First deadline.',
    'Second line.',
    '',
    '<!-- expires_at: 2027-01-01T00:00:02Z -->',
    'Later deadline.',
    '',
    '<!-- expires_at: 2027-02-30 -->',
    'Impossible date.',
    '',
    '<!-- expires_at: tomorrow -->',
    'Unparseable date.',
    '',
    'Always visible.',
  ].join('\r\n')
  await f.edit(index, raw)
  const first = await f.note(1)
  expect(first).toContain('First deadline.')
  expect(first).not.toContain('Impossible date.')
  expect(first).not.toContain('Unparseable date.')
  expect(first).toContain('[1 paragraph with unparseable expiry date hidden]')
  f.state.now += 1000
  const read = await f.read(1)
  expect(read).not.toContain('First deadline.')
  expect(read).not.toContain('Second line.')
  expect(read).toContain('[1 paragraph past its expiry date hidden]')
  expect(read).toContain('Later deadline.')
  expect(await f.note(1)).toBe(first)
  expect(await f.note(2)).not.toContain('First deadline.')
  f.state.now += 1000
  expect(await f.read(2)).not.toContain('Later deadline.')
  expect(await f.read(2)).toContain('Always visible.')
  expect((await f.session.readFile(index)).content).toBe(raw)
})

it.each(['[deploy](deploy.md#steps "Steps")', '[[deploy.md#steps]]', '[deploy]: deploy.md#steps'])(
  'keeps a stale summary bound to its old topic until the summary itself is rewritten (%s)',
  async (link) => {
    const f = await fixture()
    const old = `${link} Deploy on Monday.`
    const fresh = `${link} Deploy on Tuesday.`
    const stale = '[Summary of deploy.md may be outdated; read deploy.md]'
    const removed = '[Summary of deploy.md removed: topic no longer exists]'
    await f.edit('deploy.md', 'Monday.')
    await f.files(0).write(f.path(index), `${old}\nOther preference.`)
    expect(await f.note(1)).toContain(old)
    await f.edit('deploy.md', 'Tuesday.')
    expect(await f.note(2)).not.toContain(old)
    expect(await f.note(2)).toContain(stale)
    await f.files(2).replaceExact!(f.path(index), 'Other preference.', 'Updated preference.')
    expect(await f.note(3)).not.toContain(old)
    expect(await f.note(3)).toContain(stale)
    expect(await f.read(3)).toBe(`${old}\n${stale}\nUpdated preference.`)
    await expect(f.files(3).write(f.path(index), await f.read(3))).rejects.toMatchObject({
      code: 'MEMORY_HIDDEN_PARAGRAPHS',
    })
    await f.files(3).replaceExact!(f.path(index), old, fresh)
    expect(await f.note(4)).toContain(fresh)
    expect(await f.read(4)).not.toContain(stale)
    await f.edit('deploy.md', '')
    expect(await f.read(4)).toBe(`${fresh}\n${removed}\nUpdated preference.`)
    expect(await f.note(5)).toContain(removed)
    expect(await f.note(5)).not.toContain(fresh)
    await rm(f.path('deploy.md'))
    expect(await f.read(6)).toContain(`${fresh}\n${removed}`)
  },
)

it.each(['workspace', 'user'] as const)('fingerprints effective topic links in %s memory', async (layer) => {
  const f = await fixture()
  try {
    await f.edit('deploy.md', 'Deploy weekly.')
    const summary = 'Deployment schedule. [[deploy.md]]'
    await f.edit(index, summary)
    const workspacePath = f.path('meta/links.json')
    const saved = await readFile(workspacePath, 'utf8')
    const path = layer === 'workspace' ? workspacePath : join(f.home, 'memory/user/meta/links.json')
    if (layer === 'user') {
      await mkdir(join(f.home, 'memory/user/meta'), { recursive: true })
      await writeFile(join(f.home, 'memory/user/deploy.md'), 'Deploy weekly.')
      await writeFile(join(f.home, 'memory/user/MEMORY.md'), summary)
      await writeFile(path, saved)
      await f.edit(index, '')
      await f.session.configure({ userEnabled: true })
    }
    expect(await f.note(1)).toContain(summary)
    const revision = () => f.session.stateRevision?.()
    const original = revision()
    await writeFile(path, JSON.stringify(JSON.parse(saved), null, 2))
    expect(revision()).toBe(original)
    await writeFile(path, saved.replace('deploy.md', 'other.md'))
    const altered = revision()
    expect(altered).not.toBe(original)
    expect(await f.note(2)).not.toContain(summary)
    await rm(path)
    expect(revision()).not.toBe(altered)
  } finally {
    await f.session.close?.()
  }
})

it.each(['missing', 'invalid JSON', 'invalid binding'])(
  'handles %s link metadata safely without hiding pre-upgrade human summaries',
  async (damage) => {
    const f = await fixture()
    const line = 'Deploy weekly. [[deploy.md]]'
    await f.edit('deploy.md', 'Deploy weekly.')
    await f.files(0).write(f.path(index), `${line}\n\nKeep this.`)
    const path = f.path('meta/links.json')
    if (damage === 'missing') await rm(path)
    else await writeFile(path, damage === 'invalid JSON' ? '{' : '{"version":1,"bindings":{"broken":null}}')
    // An agent editing another line never verifies an unbound or damaged summary.
    await f.files(1).replaceExact!(f.path(index), 'Keep this.', 'Other changes.')
    const stored = await f.session.readFile(index)
    const env = await f.environment(2)
    const ranges = f.pipeline.collectHideRanges(stored, {
      layer: 'workspace',
      files: env.workspaceFiles,
      meta: env.meta,
      now: env.now,
      validity: f.validity,
    })
    expect(buildIndexView(stored, ranges).content).not.toContain(line)
    if (damage === 'missing') {
      // Pre-upgrade / never-bound summaries stay visible in the prompt note while excluded from recall.
      expect(await f.note(2)).toContain(line)
      expect(await f.note(2)).not.toContain('[Summary of deploy.md may be outdated; read deploy.md]')
    } else {
      expect(await f.note(2)).not.toContain(line)
      expect(await f.note(2)).toContain('[Summary of deploy.md may be outdated; read deploy.md]')
    }
    // Saving MEMORY.md as a human re-confirms ordinary summary lines without rewording them.
    await f.edit(index, `${line}\n\nHuman saved.`)
    expect(await f.note(3)).toContain(line)
    const afterStored = await f.session.readFile(index)
    const afterEnv = await f.environment(3)
    const afterRanges = f.pipeline.collectHideRanges(afterStored, {
      layer: 'workspace',
      files: afterEnv.workspaceFiles,
      meta: afterEnv.meta,
      now: afterEnv.now,
      validity: f.validity,
    })
    expect(buildIndexView(afterStored, afterRanges).content).toContain(line)
  },
)

it('preserves pre-upgrade human summaries, re-confirms ordinary lines on human save, and keeps stale managed summaries hidden', async () => {
  const f = await fixture()
  try {
    const id = 'ra000000001'
    f.statuses.set(id, 'valid')
    await writeFile(f.path('conventions.md'), 'Use tabs.')
    const humanLine = '- Code style: tabs, see [conventions](conventions.md)'
    await writeFile(f.path(index), humanLine)
    // Pre-upgrade file with no meta/links.json stays visible in the note.
    expect(await f.note(1)).toContain(humanLine)
    expect(await f.note(1)).not.toContain('[Summary of conventions.md may be outdated; read conventions.md]')
    // Human save binds ordinary summaries; editing the topic then marks both ordinary and managed summaries outdated.
    const managedLine = `<!-- refinement:${id} -->\nSaved summary [conventions](conventions.md)\n<!-- /refinement:${id} -->`
    await f.edit(index, `${humanLine}\n\n${managedLine}\n\nNotes.`)
    expect(await f.note(2)).toContain(humanLine)
    expect(await f.note(2)).toContain('Saved summary [conventions](conventions.md)')
    await f.edit('conventions.md', 'Use spaces.')
    expect(await f.note(3)).not.toContain(humanLine)
    expect(await f.note(3)).toContain('[Summary of conventions.md may be outdated; read conventions.md]')
    // A human saving MEMORY.md re-confirms the ordinary summary without rewording it,
    // while leaving the unchanged managed saved paragraph hidden until updated.
    await f.edit(index, `${humanLine}\n\n${managedLine}\n\nNotes updated.`)
    expect(await f.note(4)).toContain(humanLine)
    expect(await f.note(4)).not.toContain('Saved summary [conventions](conventions.md)')
  } finally {
    await f.session.close?.()
  }
})

it('removes withdrawn references immediately from reads and recall and from the next injection', async () => {
  const f = await fixture()
  const id = 'ra123456789'
  f.statuses.set(id, 'delivered')
  const raw = `Deployment fact.\n<!-- ref:${id} -->\n\nSeparate fact with ref: ${id}\n\nStill visible.`
  await f.edit(index, raw)
  expect(await f.note(1)).toContain(raw)
  expect((await f.recall(1, 'Deployment fact')).hits).toHaveLength(1)
  f.statuses.delete(id)
  f.state.revision++
  const read = await f.read(1)
  expect(read).not.toContain('Deployment fact')
  expect(read).not.toContain('Separate fact')
  expect(read).not.toContain(id)
  expect(read).toContain('Still visible.')
  expect((await f.recall(1, 'Deployment fact')).hits).toEqual([])
  expect(await f.note(1)).toContain(raw)
  expect(await f.note(2)).not.toContain(id)
  expect(await f.note(2)).not.toContain('Deployment fact')
  const stored = await f.session.readFile(index)
  expect(stored.content).toBe(raw)
  const env = await f.environment(2)
  const ranges = f.pipeline.collectHideRanges(stored, {
    layer: 'workspace',
    files: env.workspaceFiles,
    meta: env.meta,
    now: env.now,
    validity: f.validity,
  })
  const notice = '[1 line referencing withdrawn or expired memory hidden]'
  expect(ranges).toHaveLength(2)
  for (const range of ranges) {
    expect(range).toMatchObject({
      appliesTo: 'both',
      reason: 'ref-withdrawn',
      mergeGroup: 'ref-withdrawn',
      notice,
    })
  }
  expect(buildView(stored, ranges, 'read', formatLifecycleOmission).content).toBe(
    `${notice}\n\n${notice}\n\nStill visible.`,
  )
  f.statuses.set(id, 'valid')
  f.state.revision++
  await expect(f.files(2).replaceExact!(f.path(index), 'Deployment fact.', 'Changed.')).rejects.toMatchObject(
    {
      code: 'MEMORY_REPLACE_NOT_FOUND',
    },
  )
})

it.each([
  ['replaceExact', 'expiry', 'MEMORY_REPLACE_NOT_FOUND'],
  ['replaceExact', 'withdrawal', 'MEMORY_REPLACE_NOT_FOUND'],
  ['write', 'expiry', 'MEMORY_HIDDEN_PARAGRAPHS'],
] as const)('rechecks %s when %s occurs during approval', async (operation, restriction, code) => {
  const f = await fixture()
  const id = 'r0000000001'
  f.statuses.set(id, 'valid')
  const raw =
    restriction === 'expiry'
      ? '<!-- expires_at: 2027-01-01T00:00:01Z -->\nDeployment fact.'
      : `Deployment fact. <!-- ref:${id} -->`
  const path = f.path(index)
  await f.files(0).write(path, raw)
  await f.session.configure({ mode: 'ask' })
  const port = f.files(1, async () => {
    await Promise.resolve()
    if (restriction === 'expiry') f.state.now += 1000
    else {
      f.statuses.delete(id)
      f.state.revision++
    }
    return { status: 'approved' }
  })
  const edit =
    operation === 'write'
      ? port.write(path, 'Changed.')
      : port.replaceExact?.(path, 'Deployment fact.', 'Changed.')
  await expect(edit).rejects.toMatchObject({ code })
  expect((await f.session.readFile(index)).content).toBe(raw)
})

it('maps visible text to its raw lines, preserves hidden bytes on replacement, and refuses whole-file writes', async () => {
  const f = await fixture()
  const hidden = '<!-- expires_at: 2026-12-31 -->\r\n过期的段落。\r\nSecond hidden line.\r\n'
  const raw = `Header.\r\n\r\n${hidden}\r\nVisible line.\r\nLast line.`
  const leaf = 'deploy.md'
  await f.files(0).write(f.path(leaf), raw)
  const view = (await f.environment(1)).workspaceViews.get(leaf)!
  const offset = view.content.indexOf('Visible line.')
  expect(mapViewSpanToRawLines(raw, view, offset, view.content.length)).toEqual({ lineStart: 7, lineEnd: 8 })
  expect((await f.recall(1, '过期')).hits).toEqual([])
  await expect(f.files(1).write(f.path(leaf), view.content)).rejects.toMatchObject({
    code: 'MEMORY_HIDDEN_PARAGRAPHS',
  })
  await f.files(1).replaceExact!(f.path(leaf), 'Visible line.', 'Edited line.')
  expect((await f.session.readFile(leaf)).content).toBe(raw.replace('Visible line.', 'Edited line.'))
  await f.files(1).replaceExact!(f.path(leaf), 'Edited line.', 'Final line.')
  expect((await f.session.readFile(leaf)).content).toBe(raw.replace('Visible line.', 'Final line.'))

  const silent = 'silent.md'
  await f.files(1).write(f.path(silent), 'Draft line.\nVisible line.')
  f.pipeline.addViewFilter((entry) =>
    entry.path === silent ? [{ start: 0, end: 12, appliesTo: 'read', reason: 'draft' }] : [],
  )
  const visible = Buffer.from(await f.files(2).read(f.path(silent))).toString()
  expect(visible).toBe('Visible line.')
  await expect(f.files(2).write(f.path(silent), visible)).rejects.toMatchObject({
    code: 'MEMORY_HIDDEN_PARAGRAPHS',
  })
  expect((await f.session.readFile(silent)).content).toBe('Draft line.\nVisible line.')
})

it('keeps exact edits within the observed turn limits and surviving files', async () => {
  const f = await fixture()
  await f.files(0).write(f.path(index), 'First\nSecond\nThird')
  const topic = f.path('deploy.md')
  await f.files(0).write(topic, 'Deploy now')
  await f.session.configure({ indexMaxLines: 2 })
  await f.note(1)
  await f.session.configure({ indexMaxLines: 4 })
  await expect(f.files(1).replaceExact!(f.path(index), 'Third', 'Last')).rejects.toMatchObject({
    code: 'MEMORY_CONSOLIDATION_REQUIRED',
  })
  await rm(topic)
  await expect(f.files(1).read(topic)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(topic, 'Deploy now')
  await expect(f.files(1).replaceExact!(topic, 'now', 'later')).rejects.toMatchObject({
    code: 'MEMORY_REPLACE_NOT_FOUND',
  })
  await f.files(2).replaceExact!(f.path(index), 'Third', 'Last')
  await f.files(2).replaceExact!(topic, 'now', 'later')
  expect((await f.session.readFile('deploy.md')).content).toBe('Deploy later')
})

it('checks turn-boundary views against raw filters and detects stale index chunks until rebuilt', async () => {
  const f = await fixture()
  await f.edit('deploy.md', 'Deploy on Monday.')
  await f.edit(index, 'Deploy on Monday. [[deploy.md]]')
  const capture = async (turn: number) => {
    const snapshot = await f.note(turn)
    const env = await f.environment(turn)
    return {
      pipeline: f.pipeline,
      readViews: env.workspaceViews,
      context: {
        layer: 'workspace' as const,
        files: env.meta.store.files(),
        now: env.now,
        validity: f.validity,
        meta: env.meta,
      },
      injectedIndex: snapshot.split('\n\n').slice(3).join('\n\n'),
    }
  }
  let args = await capture(1)
  let chunks: ReturnType<typeof chunkView> = []
  const rebuild = () =>
    rebuildConsistencyIndex(() => {
      chunks = args.context.files.flatMap((entry) =>
        chunkView(entry, buildIndexView(entry, args.pipeline.collectHideRanges(entry, args.context))),
      )
    })
  const inspect = () => inspectConsistency({ ...args, readIndexedChunks: () => chunks, chunkView })
  await rebuild()
  expect(await inspect()).toEqual({ ok: true, mismatches: [] })
  await f.edit('deploy.md', '<!-- expires_at: 2026-11-01 -->\nDeploy on Friday.\n\nCurrent checklist.')
  args = await capture(2)
  expect(await inspect()).toEqual({ ok: false, mismatches: ['index: MEMORY.md', 'index: deploy.md'] })
  await rebuild()
  expect(chunks.some(({ text }) => text.includes('Friday'))).toBe(false)
  expect(await inspect()).toEqual({ ok: true, mismatches: [] })
  await rm(f.path('deploy.md'))
  args = await capture(3)
  expect((await inspect()).mismatches).toContain('index: deploy.md')
  await rebuild()
  expect(await inspect()).toEqual({ ok: true, mismatches: [] })
  expect(
    (await inspectConsistency({ ...args, injectedIndex: 'stale', readViews: new Map() })).mismatches,
  ).toEqual(['read: MEMORY.md', 'injection: MEMORY.md'])
})
