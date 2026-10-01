import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jcs } from '@agnes/protocol'
import { type AuditAppend, canonicalJsonDigest, type ScopeRef } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { openReferenceAuditStore } from '../../../../examples/runtime-reference/src/providers/audit-store.js'
import { openAuditStore } from '../../src/runtime/audit/store.js'
import { auditWrite } from '../../src/runtime/providers/audit.js'

const scope: ScopeRef = { kind: 'workspace', installationId: 'i', runtimeId: 'r', workspaceId: 'w' }
const input: AuditAppend = {
  subjectRef: { kind: 'event', authorityId: 'source', eventId: 'subject' },
  operation: 'sent',
  outcomeRef: { authorityId: 'source', receiptId: 'outcome', digest: 'a'.repeat(64) },
  causationRef: { kind: 'event', authorityId: 'source', eventId: 'cause' },
  redactedPayloadRef: {
    kind: 'inline',
    schema: { typeId: 'fixture/payload@1', revision: 1, digest: 'b'.repeat(64) },
    value: { safe: true },
    digest: canonicalJsonDigest({ safe: true }),
    bytes: 13,
  },
}
const write = auditWrite(input, {
  scope,
  producer: {
    bindingId: 'binding',
    contract: 'agh.policy',
    logicalName: 'default',
    providerId: 'source-provider',
  },
  authorityId: 'audit-owner',
})
const loader = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url))
async function killAt(script: string, path: string, point: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', loader, script, path, point], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (bytes) => {
    stderr += String(bytes)
  })
  const reached = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('audit child deadline'))
    }, 10000)
    child.once('message', (message) => {
      clearTimeout(timer)
      resolve((message as { point: string }).point === point)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`audit child exited ${code}: ${stderr}`))
    })
  })
  expect(reached).toBe(true)
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}
describe.each([false, true])('real audit kill reference=%s', (reference) => {
  it.each(['before-write', 'after-write', 'before-commit', 'after-commit'])(
    'fact and audit remain atomic at %s',
    async (point) => {
      const dir = mkdtempSync(join(tmpdir(), 'audit-kill-')),
        path = join(dir, 'owner.db'),
        script = join(dir, 'child.mts')
      const storeModule = fileURLToPath(
        new URL(
          reference
            ? '../../../../examples/runtime-reference/src/providers/audit-store.ts'
            : '../../src/runtime/audit/store.ts',
          import.meta.url,
        ),
      )
      const storeFactoryName = reference ? 'openReferenceAuditStore' : 'openAuditStore'
      writeFileSync(
        script,
        `import {${storeFactoryName}} from ${JSON.stringify(storeModule)};\nconst store=${storeFactoryName}(process.argv[2],'audit-owner',point=>{if(point===process.argv[3]){process.send?.({point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}});\nstore.commitFactAndAudit('fact',{sent:true},${JSON.stringify(write)});\n`,
      )
      try {
        await killAt(script, path, point)
        const recovered = reference
          ? openReferenceAuditStore(path, 'audit-owner')
          : openAuditStore(path, 'audit-owner')
        try {
          const present = point === 'after-commit'
          expect(recovered.readFact('fact')).toEqual(present ? { sent: true } : null)
          expect(recovered.page(jcs(scope), 0, 50)).toHaveLength(present ? 1 : 0)
          if (present) {
            const first = recovered.append(write)
            expect(recovered.commitFactAndAudit('fact', { sent: true }, write)).toEqual(first)
            expect(recovered.page(jcs(scope), 0, 50)).toHaveLength(1)
          }
        } finally {
          recovered.close()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    20000,
  )
})
