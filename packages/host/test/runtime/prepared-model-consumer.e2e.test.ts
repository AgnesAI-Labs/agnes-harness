import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { createPreparedModelSourceFixture, preparedSourceDigest } from './fixtures/prepared-model-source.js'

it.each(['default', 'reference'] as const)(
  'consumes complete official prepared source through real State actions and %s wire',
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'prepared-model-'))
    const requests = join(directory, 'requests.jsonl')
    const peer: ChildProcess = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../../ai/test/runtime/fixtures/model-http.mjs', import.meta.url)), requests],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'C' } },
    )
    let fixture: Awaited<ReturnType<typeof createPreparedModelSourceFixture>> | undefined
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Wire startup deadline')), 10000)
        peer.once('message', (message) => {
          clearTimeout(timer)
          const result = validateRuntime('JsonValue', message)
          if (
            !result.ok ||
            !result.value ||
            Array.isArray(result.value) ||
            typeof result.value !== 'object' ||
            typeof result.value.port !== 'number'
          )
            return reject(Error('Invalid wire port'))
          resolve(result.value.port)
        })
        peer.once('exit', () => {
          clearTimeout(timer)
          reject(Error('Wire startup exited'))
        })
      })
      fixture = await createPreparedModelSourceFixture(directory, kind, `http://127.0.0.1:${port}/v1`)
      const first = await fixture.prepare('first genuine prompt', 1)
      expect(first.reference.schema).toEqual(RuntimeSchemaRefs.PreparedModelRequest)
      expect(
        validateRuntime(
          'PreparedModelRequest',
          first.reference.kind === 'inline' ? first.reference.value : null,
        ).ok,
      ).toBe(true)
      const original = preparedSourceDigest(fixture.readAction(first.actionId))
      const result = await fixture.invoke(first)
      expect(result.outcome, JSON.stringify(result)).toBe('succeeded')
      expect(result.result).toBeDefined()
      expect(result.usage).toHaveLength(1)
      const originalSource = fixture.sourceDB
        .prepare('SELECT body,digest FROM prepared_sources WHERE id=?')
        .get(first.prepared.preparedId)
      const next = await fixture.prepare('new genuine prompt', 2, first.reference)
      expect(next.actionId).not.toBe(first.actionId)
      expect(next.reference.digest).not.toBe(first.reference.digest)
      expect(next.prepared.target.priceVersion).toBe('fixture-price-2')
      expect(preparedSourceDigest(fixture.readAction(first.actionId))).toBe(original)
      expect(
        fixture.sourceDB
          .prepare('SELECT body,digest FROM prepared_sources WHERE id=?')
          .get(first.prepared.preparedId),
      ).toEqual(originalSource)
      expect((await fixture.invoke(first, next.reference)).outcome).toBe('failed')
      expect(readFileSync(requests, 'utf8').trim().split('\n')).toHaveLength(1)
      expect((await fixture.invoke(next)).outcome).toBe('succeeded')
      fixture.sourceDB.prepare('DELETE FROM prepared_sources WHERE id=?').run(next.prepared.preparedId)
      expect((await fixture.invoke(next)).outcome).toBe('failed')
      const wire = readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(wire).toHaveLength(2)
      expect(wire.every((request) => request.credentialMatched)).toBe(true)
      expect(JSON.stringify(wire[0].input)).toContain('first genuine prompt')
      expect(JSON.stringify(wire[1].input)).toContain('new genuine prompt')
      expect(existsSync(join(directory, 'receipt.json'))).toBe(true)
    } finally {
      await fixture?.close()
      if (peer.exitCode === null) {
        const stopped = new Promise<void>((resolve) => peer.once('exit', () => resolve()))
        peer.kill()
        await stopped
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
  30000,
)
