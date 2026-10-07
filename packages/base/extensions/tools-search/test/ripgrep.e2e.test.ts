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
      await writeFile(join(cwd, 'a.txt'), 'match one\nmatch two\nmatch three\n')
      await writeFile(join(cwd, 'node_modules', 'ignored.txt'), 'match hidden')
      await writeFile(join(cwd, 'secrets', 'private.txt'), 'match private')
      await symlink(join(cwd, 'secrets'), join(cwd, 'link'))
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
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
