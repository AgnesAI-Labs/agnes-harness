import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { createReferenceExec } from '../../../../examples/runtime-reference/src/providers/exec.js'
import { createReferenceSandbox } from '../../../../examples/runtime-reference/src/providers/sandbox.js'
import type * as W from '../../../protocol/src/runtime/index.js'
import { executionGovernorPath } from '../../src/runtime/platform/resource-owners.js'
import { createExecService } from '../../src/runtime/providers/exec.js'
import { createSandboxService } from '../../src/runtime/providers/sandbox.js'
import { cleanup, error, must } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'
import {
  alive,
  executionRef,
  limitCase,
  pids,
  scenario,
  terminateActive,
  until,
} from './sandbox-exec-scenarios.js'

describe.skipIf(process.platform !== 'darwin').each(['default', 'reference'] as const)(
  '%s execution owners',
  (kind) => {
    it.each(['cpuMs', 'wallMs', 'memoryBytes', 'outputBytes', 'processes', 'openFiles'] as const)(
      'enforces %s and proves no live descendants',
      async (field) => {
        await limitCase(kind, field)
      },
      30000,
    )
    it.each(['cancel', 'release', 'stop', 'dispose'] as const)(
      'drains an escaped child after %s',
      async (operation) => {
        await terminateActive(kind, operation)
      },
      30000,
    )
    it.each(['sandbox', 'exec'] as const)(
      'recovers %s without replay',
      async (service) => {
        await scenario(kind, service, 'recover')
      },
      30000,
    )
    it('refuses completion for a double-forked lifeline holder and reaps it', async () => {
      const f = await fixture(kind)
      try {
        const binary = join(f.roots.workspace, 'orphan-probe')
        execFileSync('cc', ['-O2', '-o', binary, fileURLToPath(new URL('./orphan-probe.c', import.meta.url))])
        const s = await f.ready(),
          trace = join(f.roots.workspace, 'orphan')
        const reply = await f.exec.run(f.request(s, [binary, trace]), f.auth.call())
        assert.equal(error(reply), 'unknown_effect/exec_residual')
        if (reply.ok) throw new Error('Falsely completed')
        const detail = reply.error.safeDetail as {
          metrics: { reason: string; ownershipVerified: boolean; remaining: number }
        }
        assert.equal(detail.metrics.reason, 'residual')
        assert.equal(detail.metrics.ownershipVerified, true)
        assert.equal(detail.metrics.remaining, 0)
        await until(() => pids(trace).every((pid) => !alive(pid)))
        assert.equal(
          must(await f.exec.reconcile({ executionRef: executionRef(reply) }, f.auth.call())).kind,
          'unknown',
        )
      } finally {
        await f.close()
        cleanup(f.directory)
      }
    }, 30000)
    it('keeps stop unknown when an execution has no ownership proof', async () => {
      const f = await fixture(kind)
      try {
        const s = await f.ready()
        must(
          await f.sandbox.withExecution(f.request(s, ['/bin/echo']), f.auth.call(), async () => ({
            ok: false as const,
            error: { code: 'unknown_effect', safeDetail: {} },
          })),
        )
        assert.equal(
          must(await f.sandbox.stop({ sandboxRef: s.sandboxRef, reason: 'uncertain owner' }, f.auth.call()))
            .effectStatus,
          'unknown',
        )
        assert.equal(
          must(await f.sandbox.stop({ sandboxRef: s.sandboxRef, reason: 'repeat' }, f.auth.call()))
            .effectStatus,
          'unknown',
        )
      } finally {
        await f.close()
        cleanup(f.directory)
      }
    })
    it.each(['kill', 'lost'] as const)(
      'recovers %s worker without replay or ownerless processes',
      async (mode) => {
        const f = await fixture(kind),
          directory = join(f.directory, 'agent')
        mkdirSync(directory)
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL(
                '../../../../tools/acceptance/runtime/fixtures/platform-exec-agent.ts',
                import.meta.url,
              ),
            ),
            kind,
            directory,
            mode,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let log = ''
        child.stderr.on('data', (b) => {
          log += b.toString()
        })
        try {
          await until(() => {
            assert.equal(child.exitCode, null, log)
            return mode === 'lost'
              ? existsSync(join(directory, 'persisted'))
              : pids(join(directory, 'workspace/pids')).length >= 2
          })
          const meta = JSON.parse(readFileSync(join(directory, 'agent.json'), 'utf8')) as {
            admitted: W.SandboxCreateResult
            input: W.ExecRequest
            invocationId: string
            bindingId: string
            executionId: string
          }
          child.kill('SIGKILL')
          await new Promise<void>((resolve) => child.once('exit', () => resolve()))
          await until(() => pids(join(directory, 'workspace/pids')).every((pid) => !alive(pid)))
          const factory = kind === 'default' ? createExecService : createReferenceExec
          const recovered = factory({ ...f.execOptions, directory: join(directory, 'executions') })
          const sb = (kind === 'default' ? createSandboxService : createReferenceSandbox)({
            ...f.sandboxOptions,
            directory: join(directory, 'sandboxes'),
          })
          try {
            const call = f.auth.call({ invocationId: meta.invocationId, bindingId: meta.bindingId })
            const reply = await recovered.run(meta.input, call)
            const ref = mode === 'lost' ? must(reply).executionRef : executionRef(reply)
            assert.equal(ref.executionId, meta.executionId)
            assert.equal(
              createHash('sha256').update(`${call.bindingId}/${call.invocationId}`).digest('hex'),
              ref.executionId,
            )
            assert.equal(
              must(await recovered.reconcile({ executionRef: ref }, f.auth.call())).kind,
              mode === 'lost' ? 'resolved' : 'unknown',
            )
            assert.equal(
              must(await sb.inspect({ sandboxRef: meta.admitted.sandboxRef }, f.auth.call())).state,
              'lost',
            )
            assert.equal(
              must(
                await sb.stop({ sandboxRef: meta.admitted.sandboxRef, reason: 'lost worker' }, f.auth.call()),
              ).effectStatus,
              'unknown',
            )
          } finally {
            await recovered.close()
            await sb.close()
          }
        } finally {
          child.kill('SIGKILL')
          await f.close()
          cleanup(f.directory)
        }
      },
      30000,
    )
  },
)

describe.skipIf(process.platform !== 'darwin')('independent recipe cross checks', () => {
  it('returns identical results and refusal codes for identical execution inputs', async () => {
    const f = await fixture(),
      reference = createReferenceExec({ ...f.execOptions, directory: join(f.directory, 'cross') })
    try {
      const s = await f.ready(),
        call = f.auth.call(),
        input = f.request(s, ['/bin/echo', 'same-input'])
      assert.deepEqual(must(await f.exec.run(input, call)), must(await reference.run(input, call)))
      for (const patch of [
        { argv: [] },
        { env: [{ name: 'PATH', value: { kind: 'literal' as const, value: '/tmp' } }] },
        { limits: { ...input.limits, cpuMs: 0 } },
        ...[1, 3, 4].map((openFiles) => ({ limits: { ...input.limits, openFiles } })),
        { cwd: { mount: f.mount, path: '../outside' } },
      ]) {
        const fresh = f.auth.call()
        assert.equal(
          error(await f.exec.run({ ...input, ...patch }, fresh)),
          error(await reference.run({ ...input, ...patch }, fresh)),
        )
      }
      for (const provider of [f.exec, reference]) {
        const identity = f.auth.call()
        const concurrent = await Promise.all([
          provider.run(f.request(s, ['/bin/echo', 'first']), identity),
          provider.run(f.request(s, ['/bin/echo', 'other']), identity),
        ])
        assert.equal(
          concurrent.filter((reply) => !reply.ok && reply.error.detailCode === 'exec_request_identity')
            .length,
          1,
        )
      }
      const nonzero = f.request(s, ['/usr/bin/false']),
        fresh = f.auth.call()
      const a = must(await f.exec.run(nonzero, fresh)),
        b = must(await reference.run(nonzero, fresh))
      assert.deepEqual(a, b)
      for (const provider of [f.exec, reference]) {
        const result = must(await provider.reconcile({ executionRef: a.executionRef }, f.auth.call()))
        assert.equal(result.kind, 'resolved')
        if (result.kind === 'resolved') {
          assert.equal(result.result.outcome, 'failed')
          assert.ok(result.result.error)
        }
      }
    } finally {
      await reference.close()
      await f.close()
      cleanup(f.directory)
    }
  })
})

describe.skipIf(process.platform !== 'darwin')('native output backpressure', () => {
  it.each(['default', 'reference'] as const)(
    'keeps %s watchdog live while stdout is unread',
    async (kind) => {
      const binary =
        kind === 'default'
          ? executionGovernorPath()
          : fileURLToPath(
              new URL('../../../../examples/runtime-reference/dist/native/execution-owner', import.meta.url),
            )
      const owner = spawn(
        binary,
        ['8000', '100', String(512 * 1024 * 1024), '1048576', '16', '256', '/usr/bin/yes'],
        { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] },
      )
      let root = 0,
        records = '',
        ended = false
      owner.once('exit', () => {
        ended = true
      })
      owner.stdio[3]?.on('data', (bytes) => {
        records += bytes.toString()
        const line = records.split('\n')[0]
        if (line) root = (JSON.parse(line) as { pid: number }).pid
      })
      owner.stderr?.resume()
      const input = owner.stdio[4]
      if (input && 'end' in input) input.end()
      try {
        await until(() => root > 0)
        await until(() => ended && !alive(root), 1500)
        assert.ok(records.includes('"ownershipVerified":true'))
        assert.ok(
          !records
            .split('\n')
            .filter(Boolean)
            .some((row) => {
              const record = JSON.parse(row) as { final: boolean; reason: string }
              return record.final && record.reason === 'completed'
            }),
        )
      } finally {
        owner.stdin?.end('cancel')
        owner.stdout?.resume()
        if (!ended) await until(() => ended, 4000)
        if (root > 0) assert.equal(alive(root), false)
      }
    },
    10000,
  )
  it.each(['default', 'reference'] as const)(
    '%s enforces the call deadline in the native owner even with a larger wall ceiling',
    async (kind) => {
      const f = await fixture(kind)
      try {
        const s = await f.ready(),
          trace = join(f.roots.workspace, 'deadline-pids'),
          started = performance.now()
        const reply = await f.exec.run(
          f.request(s, [process.execPath, join(f.roots.workspace, 'workload.mjs'), 'tree', trace]),
          f.auth.call({ deadline: new Date(Date.now() + 400).toISOString() }),
        )
        assert.equal(error(reply), 'unknown_effect/exec_unknown')
        assert.ok(performance.now() - started <= 1000)
        await until(() => pids(trace).every((pid) => !alive(pid)))
        assert.equal(
          must(await f.exec.reconcile({ executionRef: executionRef(reply) }, f.auth.call())).kind,
          'unknown',
        )
      } finally {
        await f.close()
        cleanup(f.directory)
      }
    },
    30000,
  )
})
