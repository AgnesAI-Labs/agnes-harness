import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const packageId = '@sample/upgrade-gate'
export const extension = 'upgrade-gate/main'
export async function writePackage(root, managed = true) {
  const directory = join(root, 'test-package')
  await mkdir(directory)
  await mkdir(join(directory, 'client'))
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  const services = ['status', 'configuration', 'check', 'retry', 'reconcile', 'configure'].map((method) => ({
    name: `server.${method}`,
    scope: 'profile',
    kind: ['retry', 'reconcile', 'configure'].includes(method) ? 'effect' : 'query',
    inputSchema: empty,
    outputSchema: {},
    timeoutMs: 30000,
    maxResultBytes: 65536,
    ...(['retry', 'reconcile', 'configure'].includes(method)
      ? {
          effectPolicy: {
            isDestructive: true,
            isOpenWorld: true,
            replay: 'never',
            requiresApproval: 'always',
            approvalScopes: [],
          },
        }
      : {}),
  }))
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: `ext:${extension}`,
            export: 'main',
            apiRange: '^4.0.0',
            runtime: 'in-process',
            inject: managed ? ['services', 'profileRuntime'] : [],
            capabilities: {
              ui: true,
              ...(managed
                ? {
                    store: true,
                    services,
                    managedServices: [
                      {
                        id: 'server',
                        scope: 'profile',
                        artifact: { kind: 'in-process' },
                        apiVersion: '1.0.0',
                        healthPath: '/health',
                        listeners: [],
                        requires: [],
                        startupTimeoutMs: 1000,
                        shutdownTimeoutMs: 1000,
                      },
                    ],
                    streams: [
                      {
                        name: 'sample.events',
                        scope: 'profile',
                        lane: 'events',
                        inputSchema: empty,
                        directions: ['outbound'],
                        maxFrameBytes: 1024,
                        maxBufferedBytes: 2048,
                        maxBytesPerSecond: 4096,
                      },
                    ],
                  }
                : {}),
            },
          },
        ],
        clientDescriptors: [{ rowId: `ext:${extension}`, path: './client/agnes.client.json' }],
      },
    }),
  )
  await writeFile(
    join(directory, 'client', 'agnes.client.json'),
    JSON.stringify({
      client: {
        entry: './client.mjs',
        slots: ['workbench.panel'],
        services: [],
        projections: [],
        ...(managed ? { streams: ['sample.events'] } : {}),
      },
    }),
  )
  await writeFile(join(directory, 'client', 'client.mjs'), 'export default { apply() {} }\n')
  await writeFile(
    join(directory, 'index.mjs'),
    managed
      ? `
export const main = { inject: ['services', 'profileRuntime'], apply(ctx) {
  ctx.profileRuntime.register({ id: 'server',
    configSchema: ${JSON.stringify(empty)}, defaultConfig: {},
    async start(init) {
      init.onShutdown(async () => ({ state: 'settled' })); init.ready(); return { synthetic: true };
    },
    async check(value) { return value; }
  });
} };
`
      : 'export const main = { apply() {} };\n',
  )
  return directory
}
