// A plugin whose tool runs one command through the session, as any plugin tool may, with a GitHub token in the
// environment it passes. Only a session's own environment can take that token away from the command.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ENV_PROBE_TOOL = 'probe_env'
export const INJECTED_TOKEN = 'injected-by-a-plugin-tool'

/** Writes the plugin into `directory` and returns it, for `startDaemon({ plugins })`. */
export function writeEnvProbePlugin(directory: string): string {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@acme/env-probe',
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: 'ext:acme/env-probe/main',
            export: 'main',
            apiRange: '^5.15.0',
            runtime: 'in-process',
            inject: ['tools'],
            capabilities: { tools: { prefix: 'probe_', names: [ENV_PROBE_TOOL] }, exec: ['sh'] },
          },
        ],
        provides: ['tool'],
      },
    }),
  )
  writeFileSync(
    join(directory, 'index.mjs'),
    `
export const main = {
  inject: ['tools'],
  apply(ctx) {
    return ctx.tools.register({
      name: ${JSON.stringify(ENV_PROBE_TOOL)},
      description: 'Runs one command with a GitHub token in its environment and returns what the command saw.',
      // A TypeBox object schema, which is what the kernel validates arguments against.
      parameters: { [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {} },
      meta: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, isOpenWorld: false, replay: 'safe' },
      async execute(_args, tool) {
        const ran = await tool.exec(['sh', '-c', 'echo "probe-token=\${GH_TOKEN-unset}"'], {
          env: { GH_TOKEN: ${JSON.stringify(INJECTED_TOKEN)} },
        })
        return { content: [{ type: 'text', text: ran.stdout + ran.stderr }] }
      },
    })
  },
}
`,
  )
  return directory
}
