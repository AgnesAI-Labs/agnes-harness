import { readFileSync, writeFileSync } from 'node:fs'
import { managedServiceCapabilities } from '@agnes/extension-api'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { managedConfigSchema, projectionCapability, ROW, SERVICE_CAPABILITIES } from '../src/contracts.js'

const path = new URL('../package.json', import.meta.url)
const previous = readFileSync(path, 'utf8')
const pkg = JSON.parse(previous)
pkg.agnes.plugins = [
  {
    id: ROW,
    export: 'knowledgeSourcesPlugin',
    apiRange: '^4.0.0',
    runtime: 'in-process',
    default: false,
    inject: ['tools', 'services', 'projections', 'eventLog', 'profileRuntime', 'self'],
    capabilities: {
      ui: true,
      store: true,
      artifacts: true,
      filesystem: { read: ['workspace/**'] },
      tools: { prefix: 'knowledge_', names: ['knowledge_query'] },
      events: true,
      projections: [projectionCapability(pluginRowSource(ROW))],
      services: [...SERVICE_CAPABILITIES, ...managedServiceCapabilities('knowledge', managedConfigSchema)],
      managedServices: [
        {
          id: 'knowledge',
          scope: 'profile',
          artifact: { kind: 'in-process' },
          healthPath: '/health',
          listeners: [],
          startupTimeoutMs: 10000,
          shutdownTimeoutMs: 5000,
          apiVersion: '1.0.0',
          requires: [],
        },
      ],
    },
    metadata: pkg.agnes.metadata,
  },
]
const next = `${JSON.stringify(pkg, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (JSON.stringify(pkg) !== JSON.stringify(JSON.parse(previous)))
    throw new Error('Knowledge manifest differs; run pnpm --filter @agnes/knowledge-sources manifest')
} else writeFileSync(path, next)
