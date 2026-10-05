import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { openEvents, producer, publication, read, reader } from './fixtures/events-issuer.js'

const issuer = fileURLToPath(new URL('./fixtures/events-issuer.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))

/** Runs the issuer over `file`, kills it with SIGKILL once it printed its cursors, and returns them. */
function killIssuer(file: string): Promise<{ signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', issuer, file], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('\n')) child.kill('SIGKILL')
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (_code, signal) => {
      clearTimeout(timer)
      if (stdout.includes('\n')) resolve({ signal, stdout })
      else reject(new Error(`events issuer printed no cursors\n${stderr}`))
    })
  })
}

it('refuses cursors a killed process issued and serves its whole history from the start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-events-recovery-'))
  const file = join(directory, 'domain.db')
  try {
    const killed = await killIssuer(file)
    expect(killed.signal).toBe('SIGKILL')
    const issued = JSON.parse(killed.stdout) as { page: string; checkpoint: string }
    // A new process with a key of its own: nothing the killed process signed is accepted.
    const events = openEvents(file, randomBytes(32))
    try {
      for (const cursor of [issued.page, issued.checkpoint])
        expect(await events.subscribe(read(cursor), reader())).toMatchObject({
          ok: false,
          error: { code: 'conflict', detailCode: 'resync_required' },
        })
      const history: { key: string; eventId: string; sequence: number }[] = []
      let cursor: string | null = null
      do {
        const page = await events.subscribe(read(cursor), reader())
        if (!page.ok) throw new Error(page.error.detailCode)
        for (const record of page.value.page.items)
          history.push({
            key: record.event.idempotencyKey,
            eventId: record.event.eventId,
            sequence: record.sequence,
          })
        cursor = page.value.page.nextCursor
      } while (cursor !== null)
      expect(history.map((entry) => [entry.key, entry.sequence])).toEqual([
        ['restart-1', 1],
        ['restart-2', 2],
        ['restart-3', 3],
      ])
      expect(new Set(history.map((entry) => entry.eventId)).size).toBe(3)
      // A same-key replay after the restart returns the committed event and writes nothing.
      expect(await events.publish(publication('restart-2'), producer())).toEqual({
        ok: true,
        value: { eventRef: { kind: 'event', authorityId: 'authority-1', eventId: history[1]?.eventId } },
      })
      const after = await events.subscribe(read(null, 10), reader())
      expect(after.ok && after.value.page.items.map((record) => record.event.eventId)).toEqual(
        history.map((entry) => entry.eventId),
      )
    } finally {
      events.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
