import { randomUUID } from 'node:crypto'
import { rpcError } from '@agnes/protocol'
import type { AdminPlanParams } from '@agnes/protocol/gen/app-server'
import { executeJournaledEffect } from './methods/extensions.js'
import type { SessionJobServices } from './session-jobs.js'

/** Invoked only after local admin and canonical registered-workspace admission. */
export function createPlanCommands(services: SessionJobServices) {
  const { activationBarrier, journal, commandQueue, callService, inspectService, resolveService } = services
  return async (input: AdminPlanParams) => {
    if (!input.sessionId)
      return { active: false, text: 'Plan mode is off (open a session to select a provider)' }
    const sessionId = input.sessionId
    const activation = activationBarrier.admit('service')
    return activation.run(async () => {
      const binding = await resolveService(sessionId, ['plan.status', 'plan.command'])
      if (!binding) return { active: false, text: 'Plan mode is off (provider unavailable)' }
      if (binding.workspaceRoot !== input.cwd) throw rpcError('CAPABILITY_DENIED')
      const commandId = randomUUID()
      const params = {
        sessionId,
        extension: binding.extension,
        service: 'plan.command',
        input: { line: input.line },
        commandId,
      }
      const credential = {
        kind: 'surface-service',
        source: 'plan-admin',
        subjectCredential: { kind: 'local' },
        grants: [{ extension: binding.extension, name: 'plan.command', range: '*' }],
      }
      if ((await inspectService(params, credential)).kind !== 'effect') throw rpcError('CAPABILITY_DENIED')
      const result = await executeJournaledEffect({
        journal,
        commandQueue,
        callService,
        params,
        credential,
        signal: new AbortController().signal,
        serviceId: `service:plan:${input.sessionId}`,
        identity: {
          principalId: 'local',
          clientId: 'plan-admin',
          sessionId,
          commandId,
        },
        bindingKind: 'plan.command',
      })
      const output = result.output
      if (
        !output ||
        typeof output !== 'object' ||
        Array.isArray(output) ||
        typeof output.active !== 'boolean' ||
        typeof output.text !== 'string'
      )
        throw rpcError('INTERNAL_ERROR')
      return { active: output.active, text: output.text }
    })
  }
}
