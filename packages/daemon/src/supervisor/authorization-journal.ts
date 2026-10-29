import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AutomaticPermissionEvidence } from '@agnes/daemon-rpc/local/prompter'
import { compilePluginConfig } from '@agnes/protocol'

const text = { type: 'string', minLength: 1, maxLength: 4096 }
const actor = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'org', 'role', 'deptPath', 'attrs'],
  properties: {
    id: text,
    org: { ...text, minLength: 0 },
    role: { ...text, minLength: 0 },
    deptPath: { type: 'array', items: { ...text, minLength: 0 } },
    attrs: { type: 'object', additionalProperties: { type: 'string', maxLength: 1024 } },
  },
}
/** Private recovery journal: exact non-secret bindings, never generic audit redaction. */
const check = compilePluginConfig({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'kind', 'detail'],
  properties: {
    version: { const: 1 },
    kind: { const: 'permission.authorization' },
    detail: {
      type: 'object',
      additionalProperties: false,
      required: [
        'requestId',
        'stepId',
        'sessionKey',
        'sessionId',
        'epoch',
        'scope',
        'bindingHash',
        'deadline',
        'at',
        'consumption',
        'verdict',
        'reason',
        'answeredBy',
      ],
      properties: {
        requestId: text,
        stepId: text,
        policyBinding: text,
        profileHash: text,
        sessionKey: text,
        sessionId: text,
        epoch: { type: 'integer', minimum: 0 },
        toolUseId: text,
        scope: text,
        bindingHash: text,
        deadline: text,
        at: text,
        consumption: { enum: ['authorized', 'consumed', 'revoked'] },
        verdict: { const: 'allowed-once' },
        reason: { const: 'full-access' },
        answeredBy: actor,
      },
    },
  },
})
export async function journalAuthorization(path: string, evidence: AutomaticPermissionEvidence) {
  // Free-form tool summaries may contain arguments or credentials; they are deliberately absent.
  const { summary: _summary, ...detail } = structuredClone(evidence)
  const row = { version: 1, kind: 'permission.authorization', detail }
  if (check(row).length) throw new Error('Invalid private authorization journal entry')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'a', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(row)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
}
