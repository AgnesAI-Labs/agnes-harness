import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportBatch } from '../src/batch/export.js'
import { BatchRepo, type BatchRow } from '../src/batch/repo.js'
import { sqliteTables } from './sqlite-tables.js'

// Lets a test act right after the export opens a file, the window a folder swap would use.
const race = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string) => void) | undefined,
  opened: [] as string[],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const path = String(args[0])
      if (path.endsWith('.tmp')) {
        race.opened.push(path)
        race.afterOpen?.(path)
      }
      return handle
    },
  }
})

const id = 'b0123456789ab'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-export-race-'))
  race.afterOpen = undefined
  race.opened = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function seeded(): { repo: BatchRepo; batch: BatchRow } {
  const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
  repo.create(
    {
      id,
      principalId: 'p',
      root,
      spec: { dir: 'docs', prompt: 'x' },
      dirRel: 'docs',
      outRel: `agh-batch/${id}`,
      concurrency: 1,
      itemTimeoutMs: 600_000,
      createdAt: 0,
    },
    [{ path: 'docs/a.txt', kind: 'text', bytes: 1 }],
  )
  repo.settle(id, 1, { status: 'done', output: { text: 'a' }, credits: 0 })
  return { repo, batch: repo.get(id) as BatchRow }
}

describe.skipIf(process.platform === 'win32')(
  'exportBatch: a results folder swapped while it is written',
  () => {
    it('stops at the first file created after the swap', async () => {
      const out = join(root, 'agh-batch', id)
      const decoy = join(root, 'decoy')
      mkdirSync(decoy)
      race.afterOpen = () => {
        race.afterOpen = undefined
        renameSync(out, join(root, 'moved'))
        symlinkSync(decoy, out)
      }
      const { repo, batch } = seeded()
      await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(/changed while it was written/)
      expect(race.opened).toHaveLength(1)
      expect(readdirSync(decoy)).toEqual([])
    })

    it('removes only the files it created and names what it left in place', async () => {
      const out = join(root, 'agh-batch', id)
      const decoy = join(root, 'decoy')
      mkdirSync(decoy)
      race.afterOpen = (path) => {
        if (!basename(path).startsWith('.summary.md.')) return
        race.afterOpen = undefined
        // The earlier temporary files now resolve into the decoy, where other files wait under their names.
        renameSync(out, join(root, 'moved'))
        symlinkSync(decoy, out)
        for (const opened of race.opened) writeFileSync(join(decoy, basename(opened)), 'not ours')
      }
      const { repo, batch } = seeded()
      await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(/temporary files left in place: /)
      expect(race.opened).toHaveLength(4)
      for (const opened of race.opened)
        expect(readFileSync(join(decoy, basename(opened)), 'utf8')).toBe('not ours')
    })
  },
)
