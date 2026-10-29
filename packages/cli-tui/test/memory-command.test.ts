import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { memorySlash } from '../src/memory-command.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const rejected = (reason: string) => ({ code: -32003, data: { code: 'SEMANTIC_REJECTED', reason } })

/** A daemon that keeps memory files in a map and applies admin.memory's read / compare-and-swap write. */
function harness(files: Record<string, string>, over: { fail?: unknown; editor?: string } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const entry = (path: string) => ({
    path,
    hash: hash(files[path] ?? ''),
    bytes: Buffer.byteLength(files[path] ?? ''),
    lines: 0,
    content: files[path] ?? '',
  })
  const inspection = () => ({
    root: '/memory/ws',
    settings: { mode: 'ask', totalMaxBytes: 102400 },
    files: Object.keys(files).map((path) => ({ path, bytes: Buffer.byteLength(files[path] as string) })),
    bytes: Object.values(files).reduce((n, text) => n + Buffer.byteLength(text), 0),
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'agh-memory-test-'))
  dirs.push(tmpDir)
  const app = {
    locale: 'en',
    cwd: '/work/ws',
    o: { externalEditor: { env: { EDITOR: over.editor ?? '' }, tmpDir } },
    renderer: { suspend: () => () => {}, requestRender: () => {} },
    session: {
      id: 'sess-1',
      client: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push(params)
          if (over.fail) throw over.fail
          expect(method).toBe('_agnes/v1/admin.memory')
          const path = params.file as string | undefined
          if (path && params.content !== undefined) {
            if (params.baseHash !== entry(path).hash) throw rejected('MEMORY_CONFLICT')
            files[path] = params.content as string
          }
          return { workspaces: [], inspection: inspection(), ...(path ? { file: entry(path) } : {}) }
        },
      },
    },
  } as unknown as TuiApp
  return { app, calls, files }
}

// A real, non-interactive editor: node runs the script on the file it is given.
const node = (script: string): string =>
  `${JSON.stringify(process.execPath.split(sep).join('/'))} -e ${JSON.stringify(script)}`

describe('/memory', () => {
  it('lists the files, with the mode and the space used', async () => {
    const { app, calls } = harness({ 'MEMORY.md': '- [Style](style.md)\n', 'style.md': 'tabs\n' })
    const r = await memorySlash(app, '/memory')
    expect(calls).toEqual([{ cwd: '/work/ws' }])
    expect(r.text).toMatch(/Memory \(ask\)/)
    expect(r.text).toMatch(/MEMORY\.md {2}20 B/)
    expect(r.text).toMatch(/style\.md {2}5 B/)
  })

  it('shows one file, takes the name with or without .md, and refuses one that does not exist', async () => {
    const { app } = harness({ 'MEMORY.md': 'index\n', 'style.md': 'use tabs\x1b[31m\n' })
    expect((await memorySlash(app, '/memory show style')).text).toBe('style.md · 14 B\nuse tabs[31m\n')
    expect((await memorySlash(app, '/memory show nothing.md')).text).toMatch(
      /No memory file named nothing\.md/,
    )
    expect((await memorySlash(app, '/memory show ../x.md')).text).toMatch(/^usage:/)
  })

  it('writes an added note only after confirm, appended to MEMORY.md with the hash it read', async () => {
    const { app, calls, files } = harness({ 'MEMORY.md': '- first' })
    const card = await memorySlash(app, '/memory add   prefers\n tabs ')
    expect(card.text).toMatch(/Add to MEMORY\.md:\n- prefers tabs\nNothing is written/)
    expect(calls).toEqual([])
    const done = await memorySlash(app, '/memory confirm')
    expect(done.text).toBe('Added the note to MEMORY.md')
    expect(files['MEMORY.md']).toBe('- first\n- prefers tabs\n')
    expect(calls.at(-1)).toMatchObject({ file: 'MEMORY.md', baseHash: hash('- first') })
    expect((await memorySlash(app, '/memory confirm')).text).toMatch(/no memory note waiting/)
  })

  it('drops a pending note on cancel and refuses an empty or oversized one', async () => {
    const { app, calls } = harness({ 'MEMORY.md': '' })
    await memorySlash(app, '/memory add something')
    expect((await memorySlash(app, '/memory cancel')).text).toMatch(/Dropped/)
    expect((await memorySlash(app, '/memory confirm')).text).toMatch(/no memory note waiting/)
    expect((await memorySlash(app, '/memory add')).text).toMatch(/^usage:/)
    expect((await memorySlash(app, `/memory add ${'x'.repeat(2001)}`)).text).toMatch(/longer than 2000/)
    expect(calls).toEqual([])
  })

  it('edits through $EDITOR and saves with the version it read', async () => {
    const editor = node(
      "const f=require('fs');const p=process.argv.at(-1);f.writeFileSync(p,f.readFileSync(p,'utf8').toUpperCase())",
    )
    const { app, calls, files } = harness({ 'MEMORY.md': 'index\n', 'style.md': 'tabs\n' }, { editor })
    expect((await memorySlash(app, '/memory edit style.md')).text).toBe('Saved style.md')
    expect(files['style.md']).toBe('TABS\n')
    expect(calls.at(-1)).toMatchObject({ file: 'style.md', content: 'TABS\n', baseHash: hash('tabs\n') })
  })

  it('says so when the edit changed nothing, or no editor is set, and writes nothing', async () => {
    const same = harness({ 'MEMORY.md': 'index\n' }, { editor: node('0') })
    expect((await memorySlash(same.app, '/memory edit MEMORY')).text).toBe('No changes to MEMORY.md')
    const unset = harness({ 'MEMORY.md': 'index\n' })
    expect((await memorySlash(unset.app, '/memory edit MEMORY')).text).toMatch(/VISUAL|EDITOR/)
    expect(unset.calls.every((call) => call.content === undefined)).toBe(true)
  })

  it('reports an edit that lost to a newer version instead of overwriting it', async () => {
    const editor = node(
      "const f=require('fs');const p=process.argv.at(-1);f.writeFileSync(p,f.readFileSync(p,'utf8')+'more')",
    )
    const { app, files } = harness({ 'MEMORY.md': 'index\n', 'style.md': 'tabs\n' }, { editor })
    const client = app.session.client as unknown as {
      call: (m: string, p: Record<string, unknown>) => Promise<unknown>
    }
    const call = client.call
    // Someone else saves the file while the editor is open: the write then names a stale version.
    client.call = async (method, params) => {
      if (params.content !== undefined) files['style.md'] = 'someone else\n'
      return call(method, params)
    }
    expect((await memorySlash(app, '/memory edit style')).text).toMatch(/changed while you were editing/)
    expect(files['style.md']).toBe('someone else\n')
  })

  it('reports a daemon without memory and a refused change, and rethrows anything else', async () => {
    const missing = harness({}, { fail: { data: { code: 'METHOD_NOT_FOUND' } } })
    expect((await memorySlash(missing.app, '/memory')).text).toMatch(/does not offer memory management/)
    const refused = harness({}, { fail: rejected('MEMORY_PROVIDER_UNAVAILABLE') })
    expect((await memorySlash(refused.app, '/memory')).text).toMatch(
      /refused the change: MEMORY_PROVIDER_UNAVAILABLE/,
    )
    const broken = harness({}, { fail: new Error('connection lost') })
    await expect(memorySlash(broken.app, '/memory')).rejects.toThrow('connection lost')
  })
})
