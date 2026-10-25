import { expect, it } from 'vitest'
import { webhookTriggerActor } from '../src/supervisor/webhook-sessions.js'

const trigger = { provider: 'github', ruleId: 'r1', deliveryId: 'd1' }

it.each([
  ['refuse', { unattendedApproval: 'refuse', interaction: 'unattended' }],
  ['notify', { unattendedApproval: 'notify' }],
  [undefined, { unattendedApproval: 'notify' }],
] as const)('marks a webhook delivery under %s as the rule declares attendance', (policy, attrs) => {
  // Nobody answers a `refuse` rule, so its turn offers no tool that waits on a person; under `notify`
  // the owner answers later and the turn stays attended.
  expect(webhookTriggerActor({ trigger, ...(policy ? { unattendedApproval: policy } : {}) })).toEqual({
    id: 'webhook:r1',
    org: 'webhook',
    role: 'trigger',
    deptPath: [],
    attrs: { ...trigger, ...attrs },
  })
})
