import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

type ViewElement = {
  props: {
    'data-demo-tool-view': string
    'data-demo-version': string
    children: Array<{ props: { children: string } }>
  }
}

type Registration = {
  name: string
  key: string
  id: string
  component: (props: { owner: { toolName: string; callId: string } }) => ViewElement
}

it.each(['v1', 'v2', 'broken'] as const)(
  '%s tool-view fixture registers for both shell and bash calls',
  async (release) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agnes-dsh-tool-view-'))
    try {
      const output = join(outputDirectory, 'plugin.mjs')
      await build({
        entryPoints: [
          join(
            repoRoot,
            'examples',
            'packages',
            'dsh-tool-view',
            release,
            'extensions',
            'main',
            'client',
            'index.js',
          ),
        ],
        outfile: output,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        nodePaths: [join(repoRoot, 'packages', 'web', 'node_modules')],
      })
      const { apply } = await import(pathToFileURL(output).href)
      const registrations: Registration[] = []

      apply({
        slots: {
          register(options: { name: string; key: string; id: string }, component: Registration['component']) {
            registrations.push({ ...options, component })
          },
        },
      })

      expect(registrations.map(({ name, key, id }) => ({ name, key, id }))).toEqual([
        { name: 'tool.call.toolview', key: 'bash', id: 'dsh-tool-view-bash' },
        { name: 'tool.call.toolview', key: 'shell', id: 'dsh-tool-view-shell' },
      ])

      if (release === 'broken') return
      for (const registration of registrations) {
        const view = registration.component({
          owner: { toolName: registration.key, callId: `${registration.key}-call` },
        })
        expect(view.props['data-demo-tool-view']).toBe(registration.key)
        expect(view.props['data-demo-version']).toBe(release)
        expect(view.props.children.map((child) => child.props.children)).toEqual([
          `工具调用视图 · ${release}`,
          `工具 ${registration.key}`,
          `调用 ${registration.key}-call`,
        ])
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  },
  30_000,
)
