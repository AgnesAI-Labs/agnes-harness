import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@agnes/cordis'
import { SlotRegistry } from '@agnes/web-client'
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

it.each(
  ['dsh-tool-view', 'dsh-model-picker-a', 'dsh-model-picker-b', 'dsh-input-controls'].flatMap((fixture) =>
    (fixture === 'dsh-input-controls' ? ['v1', 'v2'] : ['v1', 'v2', 'broken']).flatMap((release) =>
      ['before', 'after'].map((parent) => ({ fixture, release, parent })),
    ),
  ),
)(
  '$fixture $release follows parent $parent without reviving disposed entries',
  async ({ fixture, release, parent }) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agnes-dsh-tool-view-'))
    try {
      const output = join(outputDirectory, 'plugin.mjs')
      await build({
        entryPoints: [
          join(
            repoRoot,
            'examples',
            'packages',
            fixture,
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
      const name =
        fixture === 'dsh-tool-view'
          ? 'tool.call.toolview'
          : fixture === 'dsh-input-controls'
            ? 'conversation.input.right'
            : 'conversation.input.model'
      const count = fixture === 'dsh-tool-view' ? 2 : 1
      const slots = new SlotRegistry(new Context())
      slots.declare('fixture-parent', { kind: 'single', scope: 'session' })
      const mountParent = () =>
        slots.register(
          {
            name: 'fixture-parent',
            children: {
              [name]: {
                kind:
                  fixture === 'dsh-tool-view'
                    ? 'keyed'
                    : fixture === 'dsh-input-controls'
                      ? 'list'
                      : 'single',
                scope: 'session',
              },
            },
          },
          () => null,
        )
      let stopParent = parent === 'before' ? mountParent() : undefined
      const stop = apply({ slots })
      if (parent === 'after') {
        expect(slots.entriesOfSlot(name)).toHaveLength(0)
        stopParent = mountParent()
      }
      const registrations = slots
        .entriesOfSlot(name)
        .map((entry) => ({ ...entry, key: entry.options.key })) as unknown as Registration[]
      stopParent?.()
      stopParent = mountParent()
      expect(slots.entriesOfSlot(name)).toHaveLength(count)
      stop()
      stopParent()
      stopParent = mountParent()
      expect(slots.entriesOfSlot(name)).toHaveLength(0)
      stopParent()

      if (fixture !== 'dsh-tool-view') return
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
