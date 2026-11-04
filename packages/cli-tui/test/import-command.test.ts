import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
import { listExternalSessions } from '../src/external-sessions.js'
import { tt } from '../src/locale-extended.js'
import { oneLine } from '../src/session-commands.js'

let root: string
const cwd = '/work/proj'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-import-tui-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const roots = () => ({ claude: join(root, 'claude'), codex: join(root, 'codex') })
const file = (path: string, text: string, ageSeconds = 0) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  const t = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(path, t, t)
  return path
}
const claude = (name: string, text: string, age?: number) =>
  file(join(root, 'claude', '-work-proj', name), text, age)
const rollout = (name: string, dir: string, age?: number) =>
  file(
    join(root, 'codex', '2026', '10', '23', name),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: dir } })}\n{"type":"x"}\n`,
    age,
  )

describe('external session listing', () => {
  it('lists this workspace newest first, reads only heads, and counts files it cannot read', () => {
    claude('a.jsonl', `${JSON.stringify({ type: 'user', message: { content: 'older\x1bone' } })}\n`, 100)
    claude(
      'b.jsonl',
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'newer' }] } })}\n`,
      10,
    )
    claude('broken.jsonl', 'not json at all\n', 50)
    rollout('rollout-1.jsonl', cwd, 20)
    rollout('rollout-2.jsonl', '/somewhere/else', 5)
    const { items, skipped } = listExternalSessions(cwd, roots())
    expect(items.map((i) => [i.source, i.title])).toEqual([
      ['claude-code', 'newer'],
      ['codex', undefined],
      ['claude-code', 'older\x1bone'],
    ])
    expect(skipped).toBe(1)
  })

  it('offers at most 50 and tolerates missing directories', () => {
    expect(listExternalSessions(cwd, roots())).toEqual({ items: [], skipped: 0 })
    for (let i = 0; i < 60; i++) claude(`s${i}.jsonl`, '{"type":"user"}\n', i)
    expect(listExternalSessions(cwd, roots()).items).toHaveLength(50)
  })
})

describe('/import', () => {
  const app = (o: Record<string, unknown>) =>
    ({
      cwd,
      locale: 'en',
      refuseSwitch: () => false,
      o,
      session: { id: 's', client: {} },
    }) as unknown as TuiApp

  it('says it is unavailable without a local import path (--connect and friends)', async () => {
    expect(await runSlash(app({}), '/import /x.jsonl')).toEqual({ text: tt('import.remote', 'en') })
  })

  it('imports a named file (path with spaces, optional --from) and shows the key or the reason', async () => {
    const importSession = vi.fn(async () => ({ key: 'agnes:k' }))
    const a = app({ importSession })
    expect(await runSlash(a, '/import my dir/s.jsonl --from codex')).toEqual({
      text: tt('import.done', 'en', { key: 'agnes:k' }),
    })
    expect(importSession).toHaveBeenCalledWith(resolve(cwd, 'my dir/s.jsonl'), 'codex')
    // --from may come first, as in the CLI.
    await runSlash(a, '/import --from claude my dir/t.jsonl')
    expect(importSession).toHaveBeenLastCalledWith(resolve(cwd, 'my dir/t.jsonl'), 'claude')
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    vi.stubEnv('HOME', '/tmp/agh-home')
    vi.stubEnv('USERPROFILE', '/tmp/agh-home')
    await runSlash(a, '/import ~/s.jsonl')
    expect(importSession).toHaveBeenLastCalledWith(resolve('/tmp/agh-home/s.jsonl'), undefined)
    vi.unstubAllEnvs()
    importSession.mockRejectedValueOnce(new Error('bad\x1bfile'))
    expect((await runSlash(a, '/import x.jsonl')).text).toBe(
      tt('import.failed', 'en', { reason: oneLine('bad\x1bfile') }),
    )
    expect((await runSlash(a, '/import --from')).text).toBe(tt('import.usage', 'en'))
  })

  it("opens a picker of this workspace's external sessions, with unreadable files counted", async () => {
    claude('a.jsonl', `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`)
    claude('bad.jsonl', 'garbage\n')
    const a = app({ importSession: async () => ({ key: 'k' }), externalRoots: roots() })
    const result = await runSlash(a, '/import')
    expect(result.text).toBe(tt('import.skipped', 'en', { count: 1 }))
    expect(result.sessionChoices).toMatchObject([
      { importFile: join(root, 'claude', '-work-proj', 'a.jsonl'), preset: 'claude-code', title: 'hello' },
    ])
    rmSync(join(root, 'claude'), { recursive: true })
    expect((await runSlash(a, '/import')).text).toBe(tt('import.none', 'en'))
  })
})
