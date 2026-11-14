import { readFileSync } from 'node:fs'
import { managedServiceCapabilities } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { SERVICE_ID } from '../../src/runtime/index.js'

type Manifest = {
  license: string
  agnes: {
    provides: string[]
    plugins: {
      capabilities: { tools: { prefix: string; names: string[] }; services: { name: string }[] }
    }[]
    metadata: unknown
    bundles: unknown
    hostProvidedExternals?: Record<string, string>
  }
}
const read = (path: string): Manifest => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const source = read('../../package.json')
const payload = read('../../../package-manager/bundled-plugins/superagent/package.json')

// The panel's services, one per route of the prototype's HTTP API. Names are lower case, as service names must be.
const PANEL_SERVICES = [
  'superagent.state',
  'superagent.overview',
  'superagent.search',
  'superagent.sources.list',
  'superagent.sources.refreshlabels',
  'superagent.settings.get',
  'superagent.settings.save',
  'superagent.threads.list',
  'superagent.threads.get',
  'superagent.threads.unsubscribe',
  'superagent.triggers.requeue',
  'superagent.decisions.list',
  'superagent.decisions.dismiss',
  'superagent.tickets.list',
  'superagent.tickets.get',
  'superagent.tickets.retry',
  'superagent.tickets.stop',
  'superagent.executor.pause',
  'superagent.policy.history',
  'superagent.policy.sync',
  'superagent.setup.check',
  'superagent.models.list',
  'superagent.prompts.get',
  'superagent.prompts.save',
  'superagent.prompts.preview',
]

it('ships the same plugin, bundles and metadata as the source package declares', () => {
  for (const key of ['provides', 'plugins', 'metadata', 'bundles'] as const)
    expect(payload.agnes[key], key).toEqual(source.agnes[key])
  // The payload's only external is the host-provided author API its declared range admits.
  expect(payload.agnes.hostProvidedExternals).toEqual({ '@agnes/extension-api': '^5.19.0' })
  // The trust gate admits single allowlisted licenses; the NOTICE carries the MIT text of the ported code.
  expect(payload.license).toBe('Apache-2.0')
  expect(
    readFileSync(
      new URL('../../../package-manager/bundled-plugins/superagent/NOTICE', import.meta.url),
      'utf8',
    ),
  ).toContain('Copyright (c) 2026 DeepSeek Harness Team')
})

it('declares the managed service, every panel service and every orchestrator tool', () => {
  const [plugin] = source.agnes.plugins
  const generic = managedServiceCapabilities(SERVICE_ID, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
  expect(plugin?.capabilities.services).toEqual([
    ...generic,
    ...PANEL_SERVICES.map((name) => expect.objectContaining({ name })),
  ])
  expect(plugin?.capabilities.tools.names).toHaveLength(20)
  expect(plugin?.capabilities.tools.names.every((name) => name.startsWith('orchestrator_'))).toBe(true)
  expect(plugin?.capabilities.tools.names).toContain('orchestrator_feishu_read')
})
