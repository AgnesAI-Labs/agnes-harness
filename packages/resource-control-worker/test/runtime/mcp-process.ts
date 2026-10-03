import assert from 'node:assert/strict'
import { type ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import type {
  McpCallRequest,
  McpCallResult,
  McpConnectRequest,
  McpConnectResult,
} from '@agnes/protocol/runtime'
import {
  error,
  httpPeer,
  invocation,
  type Kind,
  must,
  remove,
  scratch,
  state,
  type Transport,
} from './mcp-fixture.js'

export async function providerProcess(kind: Kind, transport: Transport, root: string, port?: number) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/mcp-provider-runner.ts', import.meta.url)),
    [kind, transport, root, ...(port ? [String(port)] : [])],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  )
  let stderr = ''
  child.stderr?.on('data', (data) => {
    stderr += String(data)
  })
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve())
    child.once('exit', () => reject(new Error(`Provider fixture exited: ${stderr}`)))
  })
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  child.on('message', (reply: { id: string; result: unknown; failed?: boolean }) => {
    const waiter = pending.get(reply.id)
    pending.delete(reply.id)
    if (reply.failed) waiter?.reject(new Error('Provider fixture operation failed'))
    else waiter?.resolve(reply.result)
  })
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Provider process lost'))
    pending.clear()
  })
  function command(op: 'connect' | 'call', invocationId: string, request?: McpCallRequest) {
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.send({ id, op, invocationId, request })
    })
  }
  return {
    child,
    connect: async () =>
      (await command('connect', 'connection')) as { result: McpConnectResult; prepared: McpConnectRequest },
    call: async (request: McpCallRequest, invocationId: string) =>
      (await command('call', invocationId, request)) as Outcome<McpCallResult>,
    close: () => stop(child, false),
    kill: () => stop(child, true),
  }
}
async function stop(child: ChildProcess, kill: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    if (kill) child.kill('SIGKILL')
    else child.disconnect()
  })
}
export async function until(predicate: () => boolean | Promise<boolean>, timeout = 10000) {
  const stop = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() >= stop) throw new Error('Fixture observation timed out')
    await pause(20)
  }
}
export async function recoverMcp(kind: Kind, transport: Transport) {
  const root = scratch()
  const peer = transport === 'streamable-http' ? await httpPeer() : undefined
  let worker = await providerProcess(kind, transport, root, peer?.port)
  try {
    const first = await worker.connect()
    const request = invocation(first.result.connectionRef, 'hang')
    const lost = worker.call(request, 'unknown-call')
    const observedLoss = lost.then(
      () => false,
      () => true,
    )
    const calls = async () =>
      transport === 'stdio'
        ? existsSync(`${root}/stdio-calls.ndjson`)
          ? readFileSync(`${root}/stdio-calls.ndjson`, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((row) => JSON.parse(row))
          : []
        : ((await peer?.calls()) ?? [])
    await until(async () => (await calls()).some((row) => row.method === 'tools/call' && row.name === 'hang'))
    await worker.kill()
    assert.equal(await observedLoss, true)
    worker = await providerProcess(kind, transport, root, peer?.port)
    assert.equal(error(await worker.call(request, 'unknown-call')), 'unknown_effect/mcp_unknown')
    const response = must(await worker.call(invocation(first.result.connectionRef), 'new-call'))
    assert.equal(state(response).value, 'hello')
    assert.equal(
      (await calls()).filter((row) => row.method === 'tools/call' && row.name === 'hang').length,
      1,
    )
    return { binding: response.provenance.producer, root }
  } finally {
    await worker.close()
    await peer?.close()
    remove(root)
  }
}
