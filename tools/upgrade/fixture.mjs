import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const packageId = '@sample/upgrade-gate'
export const extension = 'upgrade-gate/main'
// The optional probe records the old worker's real OS identity from inside its start hook.
// Verification never edits markers or grants in the upgraded home.
export async function writePackage(root, managed = true, identityProbe, legacyMetadata = false) {
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
        ...(legacyMetadata
          ? {
              metadata: {
                displayName: 'Synthetic upgrade plugin',
                summary: 'Plugin-core upgrade fixture',
                description: 'A synthetic package retained by actual saved sessions',
                category: 'developer',
              },
            }
          : {}),
        plugins: [
          {
            id: `ext:${extension}`,
            export: 'main',
            apiRange: '^5.0.0',
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
${identityProbe ? "import { execFile } from 'node:child_process';" : ''}
export const main = { inject: ['services', 'profileRuntime'], apply(ctx) {
  ctx.profileRuntime.register({ id: 'server',
    configSchema: ${JSON.stringify(empty)}, defaultConfig: {},
    async start(init) {
      init.onShutdown(async () => ({ state: 'settled' }));
      ${
        identityProbe
          ? `const { stdout } = await new Promise((resolve, reject) => execFile(process.execPath,
        ['--import', ${JSON.stringify(identityProbe.loader)}, '--input-type=module', '-e',
          ${JSON.stringify(`import { defaultProcessIdentity } from ${JSON.stringify(identityProbe.module)}; const pid = Number(process.argv[1]); const identity = await defaultProcessIdentity(pid); if (identity.state !== 'alive') throw new Error('identity unavailable'); process.stdout.write(JSON.stringify({pid, startId: identity.startId}));`)}, String(process.pid)],
        { signal: init.signal, timeout: 3000, maxBuffer: 4096 },
        (error, stdout) => error ? reject(error) : resolve({ stdout })));
      init.store.set('managed-process:server', JSON.parse(stdout));`
          : ''
      }
      init.ready(); return { synthetic: true };
    },
    async check(value) { return value; }
  });
} };
`
      : 'export const main = { apply() {} };\n',
  )
  return directory
}
