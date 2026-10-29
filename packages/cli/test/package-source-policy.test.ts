import { createClient } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runPackageCommand } from '../src/commands/package.js'
import { clients } from './admin-harness.js'
import { FakeEndpoint } from './fake-endpoint.js'

it('package source-policy prints the allowed sources, or the daemon result with --json', async () => {
  const endpoint = new FakeEndpoint()
  endpoint
    .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .on('_agnes/v1/packages.sourcePolicy', () => ({ allowedSources: 'official-only' }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  clients.push(client)
  let out = ''
  const io = { write: (t: string) => (out += t), confirm: async () => false }
  await runPackageCommand(parseArgs(['package', 'source-policy']), client, io)
  expect(out).toBe('allowed sources: official-only')
  out = ''
  await runPackageCommand(parseArgs(['package', 'source-policy', '--json']), client, io)
  expect(out).toBe('{"allowedSources":"official-only"}')
})
