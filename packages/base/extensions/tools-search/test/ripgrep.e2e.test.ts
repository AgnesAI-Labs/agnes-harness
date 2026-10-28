import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { readTool } from '../../tools-core/src/tools/read.js'
import { ripgrepFindTool, ripgrepGrepTool } from '../src/tools/ripgrep.js'

const run = promisify(execFile)

describe('bundled ripgrep', () => {
  it('searches a real tree, excludes secrets/dependencies/symlinks and spills all results beyond the row limit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agh-search-'))
    try {
      await mkdir(join(cwd, 'node_modules'))
      await mkdir(join(cwd, 'secrets'))
      await mkdir(join(cwd, 'src', '中文 空格'), { recursive: true })
      await writeFile(join(cwd, 'src', 'b.txt'), 'match direct')
      await writeFile(join(cwd, 'src', '中文 空格', 'c.txt'), 'match nested')
      await writeFile(join(cwd, 'a.txt'), 'match one\nmatch two\nmatch three\n')
      await writeFile(join(cwd, 'node_modules', 'ignored.txt'), 'match hidden')
      await writeFile(join(cwd, 'secrets', 'private.txt'), 'match private')
      await symlink(
        join(cwd, 'secrets'),
        join(cwd, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      const ctx = fakeToolContext({ cwd })
      ctx.fs.stat = async (p) => {
        const s = await stat(p)
        return { kind: s.isFile() ? 'file' : 'dir', size: s.size, mtimeMs: s.mtimeMs }
      }
      ctx.exec = async (argv, options) => {
        try {
          const result = await run(argv[0]!, argv.slice(1), { cwd: options?.cwd })
          return { ...result, code: 0, truncated: false }
        } catch (e) {
          const error = e as { code: number; stdout: string; stderr: string }
          return { ...error, truncated: false }
        }
      }
      const result = await ripgrepGrepTool.execute({ pattern: 'match', limit: 1 }, ctx)
      expect(result.isError).toBeUndefined()
      const ref = result.content.find((c) => c.type === 'ref')!
      expect(ref.type).toBe('ref')
      if (ref.type !== 'ref') throw new Error('missing spill')
      const read = await readTool.execute({ path: `artifact://${ref.ref.sha256}?size=${ref.ref.size}` }, ctx)
      expect(JSON.stringify(read)).toContain('a.txt:3:match three')
      expect(JSON.stringify(read)).not.toContain('match private')
      expect(JSON.stringify(read)).not.toContain('match hidden')
      const found = await ripgrepFindTool.execute({ pattern: '**/*.txt' }, ctx)
      expect(JSON.stringify(found)).toContain('a.txt')
      expect(JSON.stringify(found)).not.toContain('private.txt')
      for (const [glob, included, excluded] of [
        ['*.txt', 'a.txt', 'src/b.txt'],
        ['src/?.txt', 'src/b.txt', 'src/中文 空格/c.txt'],
        ['src/**/*.txt', 'src/中文 空格/c.txt', 'a.txt'],
      ]) {
        const find = await ripgrepFindTool.execute({ pattern: glob! }, ctx)
        const grep = await ripgrepGrepTool.execute({ pattern: 'match', glob: glob! }, ctx)
        for (const output of [find, grep]) {
          expect(output.isError).toBeUndefined()
          expect(JSON.stringify(output)).toContain(included!)
          expect(JSON.stringify(output)).not.toContain(excluded!)
        }
      }

      // A backend can hand back an oversized listing even when individual matches are bounded.
      // Both the row spill and the ordinary output-guard path must refuse unreadable artifacts.
      const stored = [...ctx.calls.artifacts]
      ctx.exec = async () => ({
        code: 0,
        stdout: `${'a'.repeat(17 * 1024 * 1024)}\0${'b'.repeat(17 * 1024 * 1024)}\0`,
        stderr: '',
        truncated: false,
      })
      ctx.fs.stat = async (path) => ({ kind: path === ctx.cwd ? 'dir' : 'file', size: 0, mtimeMs: 0 })
      for (const limit of [1, 1000]) {
        const oversized = await ripgrepFindTool.execute({ pattern: '*', limit }, ctx)
        expect(oversized).toMatchObject({
          isError: true,
          content: [
            {
              type: 'text',
              text: expect.stringMatching(
                /^search output is \d+ bytes, exceeding the 32 MiB artifact limit; narrow path\/pattern$/,
              ),
            },
          ],
        })
        expect(ctx.calls.artifacts).toEqual(stored)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
