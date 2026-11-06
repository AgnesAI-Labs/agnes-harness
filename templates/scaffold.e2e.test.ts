import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { npmCommand } from '../tools/toolchain/check.mjs'
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

  it.each(['file', 'link', 'directory'])(
    'preserves a foreign Windows compiler launcher (%s), then links idempotently after its owner removes it',
    async (kind) => {
      const temp = await mkdtemp(join(tmpdir(), 'agh-launcher spaces & ! #%-'))
      try {
        const target = await scaffold('tool', '@acme/launcher', join(temp, 'plugin'))
        const bin = join(target, 'node_modules/.bin')
        const launcher = join(bin, 'tsc.cmd')
        const foreign = join(temp, 'foreign.cmd')
        await mkdir(bin, { recursive: true })
        await writeFile(foreign, '@echo foreign compiler\r\n')
        if (kind === 'file') await writeFile(launcher, '@echo foreign compiler\r\n')
        else if (kind === 'link') await symlink(foreign, launcher)
        else await mkdir(launcher)
        await expect(linkLocal(target)).rejects.toThrow(/existing|different|foreign/)
        expect(await readFile(foreign, 'utf8')).toBe('@echo foreign compiler\r\n')
        if (kind !== 'directory') expect(await readFile(launcher, 'utf8')).toBe('@echo foreign compiler\r\n')
        if (kind === 'link') expect(await readlink(launcher)).toBe(foreign)
        if (kind === 'directory') expect((await lstat(launcher)).isDirectory()).toBe(true)
        await rm(launcher, { recursive: kind === 'directory' })
        await linkLocal(target)
        const owned = await readFile(launcher, 'utf8')
        await linkLocal(target)
        expect(await readFile(launcher, 'utf8')).toBe(owned)
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
    },
  )

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
        const npm = npmCommand()
        const run = (script: string, args: string[] = []) => {
          try {
            return execFileSync(npm.bin, [...npm.args, 'run', script, ...args], {
              cwd: target,
              encoding: 'utf8',
              timeout: 20000,
              stdio: 'pipe',
              env: {
                ...process.env,
                PATH: process.env.PATH?.split(delimiter)
                  .filter((entry) => !entry.replaceAll('\\', '/').includes('node_modules/.bin'))
                  .join(delimiter),
              },
            })
          } catch (error) {
            const output = error as { message?: string; stdout?: string; stderr?: string }
            throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join('\n'), {
              cause: error,
            })
          }
        }
        if (!local) {
          expect(run('build')).toContain('tsc')
          if (kind === 'tool') {
            const source = join(target, 'src/index.ts')
            const original = await readFile(source, 'utf8')
            try {
              await writeFile(source, `${original}\nconst broken: string = 42\n`)
              expect(() => run('build')).toThrow('TS2322')
            } finally {
              await writeFile(source, original)
            }
          }
        }
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
