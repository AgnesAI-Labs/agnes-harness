import { readFile, writeFile } from 'node:fs/promises'
import {
  managed,
  services,
  streams,
} from '../packages/package-manager/bundled-plugins/browser/src/contracts.mjs'

const root = new URL('../packages/package-manager/bundled-plugins/browser/', import.meta.url)
const empty = { type: 'object', properties: {}, additionalProperties: false }
const managedServices = ['status', 'configuration', 'check', 'retry', 'reconcile', 'configure'].map(
  (method) => ({
    name: managed.id + '.' + method,
    scope: 'profile',
    kind: ['retry', 'reconcile', 'configure'].includes(method) ? 'effect' : 'query',
    inputSchema: empty,
    outputSchema: {},
    timeoutMs: 30_000,
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
  }),
)
const metadata = {
  displayName: 'Built-in browser',
  summary: 'Shared browser pages for the workbench and AGH, with session isolation and human control.',
  description:
    'Managed Chromium and Playwright. Enabled by the plugin switch by default. Uses explicit session authorization.',
  locales: {
    'zh-CN': {
      displayName: '内置浏览器',
      summary: '工作台与 AGH 操作同一网页，支持会话隔离和人工接管。',
      description: '由插件开关统一管理 Chromium 和 Playwright，默认启用，遵循会话权限。',
    },
  },
}
const manifest = {
  name: '@agnes/browser',
  version: '0.1.8',
  type: 'module',
  license: 'Apache-2.0',
  exports: './index.mjs',
  files: ['index.mjs', 'src', 'dist', 'README.md', 'LICENSE', 'NOTICE', 'client-build.json'],
  engines: { node: '>=24.10' },
  agnes: {
    plugins: [
      {
        id: 'ext:browser/main',
        export: 'main',
        apiRange: '^4.0.0',
        runtime: 'in-process',
        inject: ['tools', 'hooks', 'services', 'profileRuntime'],
        metadata,
        capabilities: {
          tools: { prefix: '' },
          hooks: ['context', 'shutdown'],
          store: true,
          ui: true,
          services: [...services, ...managedServices],
          streams,
          managedServices: [managed],
        },
      },
    ],
    clientDescriptors: [{ rowId: 'ext:browser/main', path: './src/agnes.client.json' }],
    metadata,
    provides: ['tool', 'ui'],
  },
  peerDependencies: { '@agnes/web-client': '0.0.0', '@agnes/web-ui': '0.0.0', react: '18.3.1' },
  devDependencies: {
    '@types/react': '18.3.12',
    'playwright-core': '1.63.0',
    '@agnes/web-client': 'workspace:*',
    '@agnes/web-ui': 'workspace:*',
    react: '18.3.1',
  },
}
const descriptor = {
  client: {
    id: 'browser',
    entry: './client.js',
    styles: ['./browser.css'],
    lifetime: 'profile',
    slotCatalogVersion: 'dsh-client-slots/v1',
    slots: [],
    services: services.map((s) => s.name),
    streams: streams.map((s) => s.name),
  },
}
for (const [path, value] of [
  ['package.json', manifest],
  ['src/agnes.client.json', descriptor],
]) {
  const text = JSON.stringify(value, null, 2) + '\n'
  const file = new URL(path, root)
  if (process.argv.includes('--check')) {
    // Whitespace is owned by the repository formatter; only JSON content is contractual here.
    if (JSON.stringify(JSON.parse(await readFile(file, 'utf8'))) !== JSON.stringify(value))
      throw new Error('Stale browser manifest: ' + path)
  } else await writeFile(file, text)
}
