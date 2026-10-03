import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Outcome } from '../../../extension-api/src/runtime/index.js'
import type * as W from '../../../protocol/src/runtime/index.js'
import { validateRuntime } from '../../../protocol/src/runtime/index.js'
import { cleanup, error, type Kind, must, selected } from './network-secrets-fixture.js'
import { fixture, limits } from './sandbox-exec-fixture.js'

export interface Metrics {
  pid: number
  reason: string
  cpuMs: number
  rss: number
  processes: number
  files: number
  outputBytes: number
  intervalMs: number
  maxGapMs: number
  remaining: number
  observedCallMs?: number
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export async function until(check: () => boolean | Promise<boolean>, milliseconds = 7000) {
  const expiry = Date.now() + milliseconds
  while (!(await check())) {
    if (Date.now() >= expiry) throw new Error('Process observation timed out')
    await pause(20)
  }
}
export function alive(pid: number) {
  try {
    const status = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return status !== '' && !status.startsWith('Z')
  } catch {
    return false
  }
}
export function pids(file: string) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}
export function executionRef(output: Outcome<W.ExecResult>): W.ExecutionRef {
  if (output.ok) return output.value.executionRef
  const detail = output.error.safeDetail as { executionRef?: W.ExecutionRef } | undefined
  assert.ok(detail?.executionRef)
  return detail.executionRef
}
export async function limitCase(kind: Kind, field: keyof W.ResourceLimits): Promise<Metrics> {
  const f = await fixture(kind)
  try {
    const sandbox = await f.ready(),
      trace = join(f.roots.workspace, 'pids')
    const ceilings = { ...limits, wallMs: 5000, openFiles: 1024 }
    const bound: W.ResourceLimits = {
      cpuMs: 200,
      wallMs: 700,
      memoryBytes: 80 * 1024 * 1024,
      outputBytes: 1024,
      processes: 2,
      openFiles: 40,
    }
    ceilings[field] = bound[field]
    const command = [
      process.execPath,
      join(f.roots.workspace, 'workload.mjs'),
      field === 'wallMs' ? 'tree' : field,
      trace,
    ]
    // The Sandbox ceiling is the immutable upper bound for each execution.
    if (ceilings.openFiles > sandbox.limits.openFiles) ceilings.openFiles = sandbox.limits.openFiles
    const started = performance.now()
    const output = await f.exec.run(f.request(sandbox, command, { limits: ceilings }), f.auth.call())
    const observedCallMs = Math.ceil(performance.now() - started)
    assert.equal(error(output), `quota/exec_limit_${field}`)
    assert.equal(output.ok, false)
    if (output.ok) throw new Error('Limit not enforced')
    const metrics = (output.error.safeDetail as unknown as { metrics: Metrics }).metrics
    assert.equal(metrics.reason, field)
    assert.equal(metrics.remaining, 0)
    assert.ok(metrics.maxGapMs > 0)
    assert.ok(metrics.maxGapMs <= 500, 'Unbounded sampler gap')
    assert.equal(alive(metrics.pid), false)
    await until(() => pids(trace).every((pid) => !alive(pid)))
    const reconciled = must(await f.exec.reconcile({ executionRef: executionRef(output) }, f.auth.call()))
    assert.equal(reconciled.kind, 'unknown')
    assert.equal(validateRuntime('ReconcileResult', reconciled).ok, true)
    if (field === 'cpuMs')
      assert.ok(metrics.cpuMs >= bound.cpuMs && metrics.cpuMs <= bound.cpuMs + 250, 'CPU sample overshoot')
    if (field === 'memoryBytes')
      assert.ok(
        metrics.rss > bound.memoryBytes && metrics.rss <= bound.memoryBytes + 32 * 1024 * 1024,
        'RSS sample overshoot',
      )
    if (field === 'processes')
      assert.ok(
        metrics.processes > bound.processes && metrics.processes <= bound.processes + 2,
        'Tree-count sample overshoot',
      )
    if (field === 'openFiles')
      assert.ok(
        metrics.files >= bound.openFiles && metrics.files <= bound.openFiles,
        'RLIMIT_NOFILE overshoot',
      )
    if (field === 'wallMs')
      assert.ok(
        observedCallMs >= bound.wallMs && observedCallMs <= bound.wallMs + 500,
        'Wall watchdog overshoot',
      )
    if (field === 'outputBytes') {
      assert.ok(metrics.outputBytes > bound.outputBytes && metrics.outputBytes <= bound.outputBytes + 16384)
      const delivered = readdirSync(join(f.directory, 'content'))
        .filter((name) => /^[a-f0-9]{64}$/u.test(name))
        .reduce((total, name) => total + statSync(join(f.directory, 'content', name)).size, 0)
      assert.ok(delivered <= bound.outputBytes, 'Retained aggregate output exceeds its hard ceiling')
    }
    return { ...metrics, observedCallMs }
  } finally {
    await f.close()
    cleanup(f.directory)
  }
}
export async function scenario(
  kind: Kind,
  service: 'sandbox' | 'exec',
  name: string,
  packageDigest?: string,
) {
  const f = await fixture(kind)
  try {
    if (name === 'select') {
      await selected(f[service], packageDigest)
      return
    }
    if (name === 'dispose') {
      await f[service].close()
      const response =
        service === 'sandbox'
          ? await f.sandbox.create(f.createInput, f.auth.call())
          : await f.exec.run({}, f.auth.call())
      assert.equal(error(response), `denied/${service}_closed`)
      return
    }
    if (name === 'cancel') {
      const abort = new AbortController()
      abort.abort()
      const response =
        service === 'sandbox'
          ? await f.sandbox.create(f.createInput, f.auth.call({ signal: abort.signal }))
          : await f.exec.run({}, f.auth.call({ signal: abort.signal }))
      assert.equal(error(response), `cancelled/${service}_cancelled`)
      return
    }
    if (name === 'deny') {
      const forged = { ...f.auth.call() }
      const response =
        service === 'sandbox' ? await f.sandbox.create(f.createInput, forged) : await f.exec.run({}, forged)
      assert.equal(error(response), `denied/${service}_denied`)
      if (service === 'exec') {
        const admitted = await f.ready()
        const secret = {
          handleId: 'fixture-handle',
          secretId: 'credential',
          version: 'v1',
          audience: 'fixture',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }
        const outcome = await f.exec.run(
          f.request(admitted, ['/bin/echo', 'blocked'], {
            env: [{ name: 'FIXTURE_VALUE', value: { kind: 'secret', handle: secret } }],
          }),
          f.auth.call(),
        )
        assert.equal(error(outcome), 'incompatible/exec_secret_env_unsupported')
        assert.equal(JSON.stringify(outcome).includes('fixture-handle'), false)
      }
      return
    }
    const admitted = await f.ready()
    if (service === 'sandbox') {
      assert.equal(
        must(await f.sandbox.inspect({ sandboxRef: admitted.sandboxRef }, f.auth.call())).state,
        'ready',
      )
      const stopped = must(
        await f.sandbox.stop({ sandboxRef: admitted.sandboxRef, reason: 'fixture' }, f.auth.call()),
      )
      assert.equal(stopped.effectStatus, 'confirmed')
      assert.deepEqual(
        must(await f.sandbox.stop({ sandboxRef: admitted.sandboxRef, reason: 'fixture' }, f.auth.call())),
        stopped,
      )
    } else {
      const input = f.request(admitted, ['/bin/echo', 'reference-result']),
        call = f.auth.call()
      const output = must(await f.exec.run(input, call))
      assert.equal(output.exitCode, 0)
      assert.equal(f.bytes(output.stdoutRef).toString(), 'reference-result\n')
      assert.deepEqual(must(await f.exec.run(input, call)), output)
      const reconciled = must(await f.exec.reconcile({ executionRef: output.executionRef }, f.auth.call()))
      assert.equal(reconciled.kind, 'resolved')
      assert.equal(validateRuntime('ReconcileResult', reconciled).ok, true)
      if (name === 'recover') {
        await f.exec.close()
        const { createExecService } = await import('../../src/runtime/providers/exec.js')
        const { createReferenceExec } = await import(
          '../../../../examples/runtime-reference/src/providers/exec.js'
        )
        const reopened =
          kind === 'default' ? createExecService(f.execOptions) : createReferenceExec(f.execOptions)
        try {
          assert.deepEqual(must(await reopened.run(input, call)), output)
          assert.equal(
            must(await reopened.reconcile({ executionRef: output.executionRef }, f.auth.call())).kind,
            'resolved',
          )
        } finally {
          await reopened.close()
        }
      }
    }
    if (name === 'recover' && service === 'sandbox') {
      await f.sandbox.close()
      const { createSandboxService } = await import('../../src/runtime/providers/sandbox.js')
      const { createReferenceSandbox } = await import(
        '../../../../examples/runtime-reference/src/providers/sandbox.js'
      )
      const reopened =
        kind === 'default' ? createSandboxService(f.sandboxOptions) : createReferenceSandbox(f.sandboxOptions)
      try {
        assert.equal(
          must(await reopened.inspect({ sandboxRef: admitted.sandboxRef }, f.auth.call())).state,
          'stopped',
        )
      } finally {
        await reopened.close()
      }
    }
  } finally {
    await f.close()
    cleanup(f.directory)
  }
}
export async function terminateActive(kind: Kind, operation: 'cancel' | 'release' | 'stop' | 'dispose') {
  const f = await fixture(kind)
  try {
    const s = await f.ready(),
      trace = join(f.roots.workspace, 'pids'),
      abort = new AbortController()
    const pending = f.exec.run(
      f.request(s, [process.execPath, join(f.roots.workspace, 'workload.mjs'), 'escape', trace]),
      f.auth.call({ signal: abort.signal }),
    )
    await until(() => pids(trace).length >= 2)
    if (operation === 'cancel') abort.abort()
    else if (operation === 'release') await f.release()
    else if (operation === 'stop')
      must(await f.sandbox.stop({ sandboxRef: s.sandboxRef, reason: 'scope release' }, f.auth.call()))
    else await Promise.all([f.sandbox.close(), f.exec.close()])
    const reply = await pending
    assert.equal(error(reply), 'unknown_effect/exec_unknown')
    await until(() => pids(trace).every((pid) => !alive(pid)))
    if (operation !== 'dispose')
      assert.equal(
        must(await f.exec.reconcile({ executionRef: executionRef(reply) }, f.auth.call())).kind,
        'unknown',
      )
  } finally {
    await f.close()
    cleanup(f.directory)
  }
}
