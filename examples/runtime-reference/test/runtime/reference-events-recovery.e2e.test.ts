import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { killWhenReady } from '../../src/providers/interaction-contract.js'
import { openStore, producer, publication, read, reader } from './fixtures/reference-events-issuer.js'

const issuer = fileURLToPath(new URL('./fixtures/reference-events-issuer.ts', import.meta.url))

/** The same signed fields presented as the other cursor kind. */
const relabel = (cursor: string, kind: 'page' | 'checkpoint') => {
  const fields = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
  fields[3] = kind
  return Buffer.from(JSON.stringify(fields)).toString('base64url')
}

it('resumes cursors a killed process issued without losing, repeating or swapping events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-events-recovery-'))
  const path = join(directory, 'events.sqlite')
  try {
    const killed = await killWhenReady([path], (stdout) => stdout.includes('\n'), issuer)
    expect(killed).toMatchObject({ signal: 'SIGKILL' })
    const issued = JSON.parse(killed.stdout) as { page: string; checkpoint: string }
    const store = openStore(path)
    try {
      expect(await store.publish(publication('restart-4'), producer)).toMatchObject({ ok: true })
      const follow = async (cursor: string) => {
        const result = await store.subscribe(read(cursor), reader)
        if (!result.ok) return result.error.detailCode
        const { items, complete } = result.value.page
        return { keys: items.map((record) => record.event.idempotencyKey), complete }
      }
      // The page cursor keeps the page set it was issued for; the later event waits for the checkpoint.
      expect(await follow(issued.page)).toEqual({ keys: ['restart-3'], complete: true })
      expect(await follow(issued.checkpoint)).toEqual({ keys: ['restart-4'], complete: true })
      expect(await follow(relabel(issued.page, 'checkpoint'))).toBe('resync_required')
      expect(await follow(relabel(issued.checkpoint, 'page'))).toBe('resync_required')
    } finally {
      store.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
