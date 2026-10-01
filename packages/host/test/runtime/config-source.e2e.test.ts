import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { documentDigest } from '../../src/runtime/config/config-digest.js'
import { readPinnedConfigDocument } from '../../src/runtime/config/host-read.js'
import { createFetchConfigProvider, type SchemaRef } from '../../src/runtime/providers/config.js'

const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const worker = fileURLToPath(new URL('./config-source-worker.ts', import.meta.url))

const PARAMETER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a'],
    },
  },
  required: ['name'],
}

function schemaRef(document: unknown, typeId: string): SchemaRef {
  return { typeId, revision: 1, digest: documentDigest(document) }
}

const parameterSchemaRef = schemaRef(PARAMETER_SCHEMA, 'acme.config/session@1')

type ReadResult = { ok: true; digest: string; revision: number; loads: number } | { ok: false; code: string }

function startWorker(args: string[], env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [tsxCli, worker, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  return {
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function readPersistent(path: string, revision?: number): Promise<ReadResult> {
  const args = revision === undefined ? ['read', path] : ['read', path, String(revision)]
  const child = startWorker(args)
  const output = collect(child)
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`read worker timed out\n${output.stderr()}`))
    }, 20_000)
    child.once('exit', (status) => {
      clearTimeout(timer)
      resolve(status ?? 1)
    })
  })
  expect(code, output.stderr()).toBe(0)
  return JSON.parse(output.stdout()) as ReadResult
}

it('reads the same persistent file from a new process and drops the previous admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-config-restart-'))
  const path = join(directory, 'local.json')
  const first = { revision: 1, schema: parameterSchemaRef, value: { name: 'pinned', meta: { a: 1 } } }
  const second = { revision: 2, schema: parameterSchemaRef, value: { name: 'newer', meta: { a: 2 } } }
  try {
    writeFileSync(path, JSON.stringify(first))
    const opened = await readPersistent(path)
    const reopened = await readPersistent(path)
    expect(opened).toEqual(reopened)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.revision).toBe(1)
    expect(opened.loads).toBe(1)
    expect(opened.digest).toBe(documentDigest(first.value))
    writeFileSync(path, JSON.stringify(second))
    const restarted = await readPersistent(path)
    expect(restarted.ok).toBe(true)
    if (!restarted.ok) return
    expect(restarted.revision).toBe(2)
    expect(restarted.digest).toBe(documentDigest(second.value))
    const forgotten = await readPersistent(path, 1)
    expect(forgotten).toMatchObject({ ok: false, code: 'source_unavailable' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

it('pins revisions served by a separate versioned process', async () => {
  const child = startWorker(['serve'], { AGNES_CONFIG_SCHEMA: JSON.stringify(parameterSchemaRef) })
  const output = collect(child)
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`versioned server did not start\n${output.stderr()}`))
      }, 20_000)
      const watch = () => {
        const line = output.stdout().split('\n')[0] ?? ''
        const match = /^ready (\d+)$/.exec(line)
        if (match?.[1] === undefined) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
      child.stdout?.on('data', watch)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error(`versioned server exited\n${output.stderr()}`))
      })
      watch()
    })
    let revision = '1'
    const http = createFetchConfigProvider(async (_sourceRef, signal) => {
      const response = await fetch(`http://127.0.0.1:${port}/${revision}`, { signal })
      if (!response.ok) throw new Error(`status ${response.status}`)
      return (await response.json()) as { revision: number; schema: SchemaRef; value: { name: string } }
    })
    expect(await http.source.refresh('remote')).toBeNull()
    const requestsAfterFirst = output.stdout().match(/^request /gm)?.length ?? 0
    const pinned = readPinnedConfigDocument(http.provider, 'remote', 1)
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    expect(output.stdout().match(/^request /gm)?.length ?? 0).toBe(requestsAfterFirst)
    expect(pinned.result.revision).toBe(1)
    expect(pinned.result.digest).toBe(documentDigest({ name: 'pinned', meta: { a: 1 } }))
    revision = '2'
    expect(await http.source.refresh('remote')).toBeNull()
    const latest = http.provider.read({ sourceRef: 'remote', revision: null })
    const still = readPinnedConfigDocument(http.provider, 'remote', 1)
    expect(latest.ok && still.ok).toBe(true)
    if (!latest.ok || !still.ok) return
    expect(latest.result.revision).toBe(2)
    expect(latest.result.digest).toBe(documentDigest({ name: 'newer', meta: { a: 2 } }))
    expect(still.result.digest).toBe(pinned.result.digest)
    expect(output.stdout().match(/^request /gm)?.length ?? 0).toBe(requestsAfterFirst + 1)
    await stop(child)
    const offline = createFetchConfigProvider(async (_sourceRef, signal) => {
      const response = await fetch(`http://127.0.0.1:${port}/1`, { signal })
      if (!response.ok) throw new Error(`status ${response.status}`)
      return (await response.json()) as { revision: number; schema: SchemaRef; value: unknown }
    })
    expect((await offline.source.refresh('remote'))?.code).toBe('source_unavailable')
    expect(readPinnedConfigDocument(http.provider, 'remote', 1).ok).toBe(true)
  } finally {
    await stop(child)
  }
}, 60_000)
