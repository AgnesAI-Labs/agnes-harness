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
        if (kind === 'loop') {
          expect(manifest.agnes.plugins[0].inject).toEqual(['tools', 'providers', 'skills'])
          const source = await readFile(join(target, 'src/index.ts'), 'utf8')
          expect(source).toContain('defineWorkflowLoop({')
          expect(source).toContain("id: '@acme/hello.world'")
          expect(source).not.toContain('source:')
          expect(source).toContain('export const main = workflow.main')
        } else if (kind === 'model-adapter') {
          expect(manifest.agnes.plugins[0].inject).toEqual(['providers'])
          expect(await readFile(join(target, 'src/index.ts'), 'utf8')).toContain(
            'ctx.providers.register(modelAdapterKind, adapter)',
          )
        }
        expect(manifest.scripts).toHaveProperty('build')
        expect(manifest.scripts).toHaveProperty('test')
        expect(manifest.agnes.provides).toEqual(
          {
            tool: ['tool'],
            'tool-with-panel': ['tool', 'ui'],
            'mcp-skills': ['skills'],
            'model-adapter': ['model-adapter'],
            loop: ['loop'],
          }[kind],
        )
        expect(manifest.agnes.plugins[0].capabilities).toEqual(
          kind === 'tool-with-panel' ? { ui: true, store: true } : kind === 'loop' ? { model: true } : {},
        )
        expect(Object.values(manifest.dependencies)).not.toContain('workspace:*')
        const local = await scaffold(kind, 'local-plugin', join(temp, `local-${kind}`), { local: true })
        const localManifest = JSON.parse(await readFile(join(local, 'package.json'), 'utf8'))
        expect(localManifest.exports).toBe('./src/index.ts')
        expect(localManifest.agnes.hostProvidedExternals).toHaveProperty('@agnes/plugin-runtime')
        const readme = await readFile(join(local, 'README.md'), 'utf8')
        expect(readme).toContain('No npm install, compilation or SDK links are needed to run it.')
        expect(readme).toContain('agh dev .agh/plugins/local-plugin')
        expect(readme).toContain('agh plugins reload local-plugin')
        expect(readme).toContain('node templates/link-local.mjs "$AGH_PLUGIN"')
        expect(readme).toContain('node "$AGH_SOURCE/agnes.mjs" plugin test "$AGH_PLUGIN"')
        expect(readme).not.toMatch(/__[A-Z_]+__|npm install\n|start\/restart/)
        expect(await readFile(join(target, 'src/index.ts'), 'utf8')).not.toMatch(
          /__PACKAGE_NAME__|__TOOL_NAME__|__SKILL_NAME__|\.\.\/.*packages\//,
        )
      }
      expect(await readFile(join(temp, 'mcp-skills/skills/hello-world/SKILL.md'), 'utf8')).toContain(
        'name: hello-world',
      )
      const panel = JSON.parse(await readFile(join(temp, 'tool-with-panel/client/agnes.client.json'), 'utf8'))
      expect(panel.client.slots).toEqual([])
      expect(panel.client.lifetime).toBe('profile')
      expect(panel.client.homeEntries[0].id).toBe('hello-world')
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

  it.each([
    ...['tool', 'loop', 'model-adapter'].map((kind) => ({ kind, local: false })),
    ...templateNames.map((kind) => ({ kind, local: true })),
  ])(
    'runs a $kind template outside the workspace (local=$local)',
    async ({ kind, local }) => {
      const temp = await mkdtemp(join(tmpdir(), 'agh-template-build-'))
      try {
        const target = await scaffold(kind, '@acme/hello', join(temp, 'plugin'), { local })
        await linkLocal(target)
        await linkLocal(target) // repeating a partial/completed link is supported
        const run = (script: string, args: string[] = []) => {
          try {
            return execFileSync('npm', ['run', script, ...args], {
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
        if (!local) expect(run('build')).toContain('tsc')
        expect(run('test')).toContain(`pass ${kind === 'tool-with-panel' ? 2 : 1}`)
        if (kind === 'tool' && local)
          expect(run('test', ['--', '--test-name-pattern=does-not-match-any-test'])).not.toContain(
            'register, invoke, reject invalid inputs and unload',
          )
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
    },
    45000,
  )
})
