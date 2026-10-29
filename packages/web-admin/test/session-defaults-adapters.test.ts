import { expect, it } from 'vitest'
import { defaultAdapterChoices } from '../src/admin/plugins/session-defaults-panel.js'

const adapter = (id: string, capabilities: Record<string, boolean>) => ({
  id,
  version: '1',
  wireApi: id,
  sourcePackage: 'local',
  capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
  models: [],
})

it('leaves a payload-only adapter out of the adapters a new session can default to', () => {
  const chat = adapter('chat', { tools: true })
  const mixed = adapter('mixed', { payload: true })
  const jev = adapter('typesafe-systemone', { payload: true, payloadOnly: true })
  expect(defaultAdapterChoices([chat, jev, mixed])).toEqual([chat, mixed])
})
