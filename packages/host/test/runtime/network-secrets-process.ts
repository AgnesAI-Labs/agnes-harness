import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as W from '@agnes/protocol/runtime'
import {
  action,
  boundary,
  cleanup,
  consumer,
  error,
  type Kind,
  loopback,
  must,
  network,
  peer,
  refreshInput,
  request,
  resolveInput,
  rule,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

export async function waitFor(check: () => boolean): Promise<void> {
  const limit = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= limit) throw new Error('Controlled peer was not reached')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
async function child(kind: Kind, directory: string, mode: string, port = 0) {
  const file = fileURLToPath(new URL('./network-secrets-child.ts', import.meta.url))
  const process = spawn(
    globalThis.process.execPath,
    ['--import', 'tsx', file, kind, directory, mode, String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let diagnostics = ''
  process.stderr.on('data', (bytes) => {
    diagnostics += bytes.toString()
  })
  const first = await new Promise<string>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => {
      process.kill('SIGKILL')
      reject(new Error('Fixture startup timed out'))
    }, 5000)
    process.on('error', reject)
    process.on('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Fixture exited before readiness: ${diagnostics}`))
    })
    process.stdout.on('data', (bytes) => {
      text += bytes.toString()
      if (text.includes('\n')) {
        clearTimeout(timer)
        resolve(text.slice(0, text.indexOf('\n')))
      }
    })
  })
  return {
    first,
    async kill() {
      if (process.exitCode !== null || process.signalCode !== null) return
      const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()))
      process.kill('SIGKILL')
      await exited
    },
  }
}

export async function recoverNetwork(kind: Kind) {
  const root = scratch()
  const remote = await peer()
  let running: Awaited<ReturnType<typeof child>> | undefined
  try {
    running = await child(kind, root, 'network', remote.port)
    assert.equal(running.first, 'started')
    await waitFor(() => remote.requests() === 1)
    await running.kill()
    const auth = boundary()
    const service = network(kind, join(root, 'network'), auth, [rule(remote.port)], { resolver: loopback })
    try {
      const call = auth.call({ invocationId: 'crashed-request', deadline: '2099-01-01T00:00:00.000Z' })
      assert.equal(
        error(await service.request(request(remote.port, '/slow'), call)),
        'unknown_effect/network_unknown',
      )
      assert.equal(remote.requests(), 1)
    } finally {
      await service.close()
    }
  } finally {
    await running?.kill()
    await remote.close()
    cleanup(root)
  }
}
export async function recoverSecrets(kind: Kind) {
  const root = scratch()
  let running: Awaited<ReturnType<typeof child>> | undefined
  try {
    running = await child(kind, root, 'secrets')
    const issued = JSON.parse(running.first) as { ok: boolean; value: W.SecretHandle }
    assert.equal(issued.ok, true)
    assert.equal(running.first.includes('not-real'), false)
    await running.kill()
    const auth = boundary()
    const broker = secrets(kind, join(root, 'secrets'), auth)
    try {
      must(
        await broker.use(issued.value, consumer, auth.call(), (value) => {
          assert.equal(value === 'not-real', true)
        }),
      )
      assert.equal(
        error(
          await broker.use(issued.value, consumer, { ...auth.call() }, () => {
            throw new Error('Forbidden exposure')
          }),
        ),
        'denied/secret_denied',
      )
      must(
        await broker.rotate(
          { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
          auth.call({}, true),
        ),
      )
      assert.equal(
        error(await broker.use(issued.value, consumer, auth.call(), () => {})),
        'denied/secret_handle',
      )
      const current = must(await broker.resolve(resolveInput, auth.call()))
      must(
        await broker.use(current, consumer, auth.call(), (value) => {
          assert.equal(value === 'rotated', true)
        }),
      )
      must(await broker.revoke({ secretId: 'credential', reason: 'maintenance' }, auth.call({}, true)))
    } finally {
      await broker.close()
    }
    const reopened = secrets(kind, join(root, 'secrets'), auth)
    try {
      assert.equal(error(await reopened.resolve(resolveInput, auth.call())), 'denied/secret_revoked')
    } finally {
      await reopened.close()
    }
  } finally {
    await running?.kill()
    cleanup(root)
  }
}
export async function recoverRefresh() {
  const root = scratch()
  const remote = await peer()
  let running: Awaited<ReturnType<typeof child>> | undefined
  try {
    running = await child('default', root, 'refresh', remote.port)
    await waitFor(() => remote.requests() === 1)
    await running.kill()
    const auth = boundary()
    let dispatched = 0
    const broker = secrets('default', join(root, 'secrets'), auth, {
      refresh: async () => {
        dispatched += 1
        return { state: 'ready', newVersionRef: 'secret://fixture/new' }
      },
    })
    try {
      const outcome = must(await broker.refresh(refreshInput, action(auth.call())))
      assert.equal(outcome.state, 'unknown')
      assert.equal(outcome.handle, null)
      assert.equal(dispatched, 0)
      assert.equal(remote.requests(), 1)
      assert.equal(
        error(await broker.refresh({ ...refreshInput, requestId: 'different-renewal' }, action(auth.call()))),
        'conflict/secret_refresh_pending',
      )
    } finally {
      await broker.close()
    }
  } finally {
    await running?.kill()
    await remote.close()
    cleanup(root)
  }
}
