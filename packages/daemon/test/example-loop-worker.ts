import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import type { TestHostOptions } from '@agnes/host/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { RequestBody } from '@agnes/protocol'
import { say } from '../../daemon-rpc/test/host.js'

const reply = 'Refund window is 30 days.'

const specs = {
  react: {
    selection: { id: 'example.react', version: '1.0.0' },
    packageId: '@agnes-example/react-loop',
    directoryName: 'react-loop',
  },
  dag: {
    selection: { id: 'example.dag', version: '1.0.0' },
    packageId: '@agnes-example/dag-loop',
    directoryName: 'dag-loop',
  },
} as const

/**
 * Host options for a worker that runs one example loop on the scripted faux route.
 * The supervisor profile file is unchanged, so the worker hello hash stays the file hash.
 * The example is loaded inside this Host the same way the Host turn test loads it.
 */
export async function exampleLoopHostOptions(input: {
  dataDir: string
  kind: keyof typeof specs
  prompter: NonNullable<TestHostOptions['prompter']>
}): Promise<TestHostOptions> {
  const spec = specs[input.kind]
  const sourceUrl = new URL(`../../../examples/loops/${spec.directoryName}/`, import.meta.url)
  const imported = await import(new URL('index.mjs', sourceUrl).href)
  const directory = join(input.dataDir, 'snapshot')
  cpSync(fileURLToPath(sourceUrl), directory, {
    recursive: true,
    filter: (path) => !path.includes('/node_modules'),
  })
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: spec.packageId,
      version: spec.selection.version,
      snapshotId: `sha256-${'1'.repeat(64)}`,
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory,
      profile: 'local-dev',
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  return {
    dataDir: input.dataDir,
    packageDirs: { [spec.packageId]: directory },
    script: [exampleScript(input.kind)],
    lock: {
      packages: Object.fromEntries(
        ['@agnes/ai', '@agnes/base', '@agnes/code', spec.packageId].map((id) => [
          id,
          {
            version: '1.0.0',
            integrity: source.snapshot.integrity,
            trust: id === spec.packageId ? 'trusted' : 'builtin',
            enabled: true,
          },
        ]),
      ),
    },
    profileInputs: {
      user: {
        name: 'local-dev',
        packages: [{ id: spec.packageId, source: `file:${directory}` }],
        loop: spec.selection,
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [
            {
              route: 'faux',
              api: 'faux',
              baseUrl: 'https://invalid.test',
              models: [fakeModel({ route: 'faux', id: 'faux-1' })],
            },
          ],
        },
      },
    },
    runtimePluginSnapshots: [source],
    runtimePluginCatalogue: [source],
    runtimePluginSources: async () => [source],
    extensionLoader: {
      import: async (file) => {
        if (!file.endsWith('/index.mjs')) throw new Error(`example loop loader refused ${file}`)
        return imported
      },
    },
    prompter: input.prompter,
    seams: {
      principals: {
        resolve: async (credential) => ({
          id: (credential as { userId?: string }).userId ?? 'unknown',
          org: 'example',
          role: 'member',
          deptPath: [],
          attrs: {},
        }),
      },
    },
  }
}

/** Title calls answer JSON. The DAG planner answers an empty plan. Every other call answers the refund line. */
function exampleScript(kind: keyof typeof specs): (request: RequestBody) => ReturnType<typeof say> {
  return (request) => {
    if (request.kind === 'summary') return say(JSON.stringify({ language: 'en', title: 'Refund window' }))
    if (kind === 'dag' && JSON.stringify(request).includes('<dag-planner-protocol>')) return say('[]')
    return say(reply)
  }
}
