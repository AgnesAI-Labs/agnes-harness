import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scaffold, templateNames } from './create-agh-plugin.mjs'
import { linkLocal } from './link-local.mjs'

describe('plugin scaffolder', () => {
  it('creates all standalone packages, replacing scoped names and asset paths', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agh-scaffold-'))
    try {
      for (const kind of templateNames) {
        const target = await scaffold(kind, '@acme/hello.world', join(temp, kind))
        const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
        expect(manifest.name).toBe('@acme/hello.world')
        expect(manifest.scripts).toHaveProperty('build')
        expect(manifest.scripts).toHaveProperty('test')
        expect(Object.values(manifest.dependencies)).not.toContain('workspace:*')
        expect(await readFile(join(target, 'src/index.ts'), 'utf8')).not.toMatch(
          /__PACKAGE_NAME__|__TOOL_NAME__|__SKILL_NAME__|\.\.\/.*packages\//,
        )
      }
      expect(await readFile(join(temp, 'mcp-skills/skills/hello-world/SKILL.md'), 'utf8')).toContain(
        'name: hello-world',
      )
      const panel = JSON.parse(await readFile(join(temp, 'tool-with-panel/client/agnes.client.json'), 'utf8'))
      expect(panel.client.slots).toEqual(['ui:sidebar'])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('rejects invalid names, unknown kinds and existing destinations without modifying them', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agh-scaffold-'))
    try {
      const marker = join(temp, 'keep.txt')
      await writeFile(marker, 'keep')
      for (const name of ['../escape', 'Bad Name', '@scope/../bad', 'x'.repeat(58)])
        await expect(scaffold('tool', name, join(temp, 'new'))).rejects.toThrow()
      await expect(scaffold('../tool', 'hello', join(temp, 'new'))).rejects.toThrow('Unknown template')
      await expect(scaffold('tool', 'hello', temp)).rejects.toThrow()
      expect(await readFile(marker, 'utf8')).toBe('keep')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('builds and runs a tool template outside the workspace through package exports', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agh-template-build-'))
    try {
      const target = await scaffold('tool', '@acme/hello', join(temp, 'plugin'))
      await linkLocal(target)
      const run = (script: string) => {
        try {
          return execFileSync('npm', ['run', script], {
            cwd: target,
            encoding: 'utf8',
            timeout: 20000,
            stdio: 'pipe',
            env: {
              ...process.env,
              PATH: process.env.PATH?.split(delimiter)
                .filter((entry) => !entry.includes('node_modules/.bin'))
                .join(delimiter),
            },
          })
        } catch (error) {
          const output = error as { stdout?: string; stderr?: string }
          throw new Error(`${output.stdout ?? ''}\n${output.stderr ?? ''}`, { cause: error })
        }
      }
      expect(run('build')).toContain('tsc')
      expect(run('test')).toContain('pass 1')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 45000)
})
