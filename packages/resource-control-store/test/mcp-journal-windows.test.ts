import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { McpResourceStore } from '../src/mcp.js'

const windows = process.platform === 'win32' // guards-allow-platform: real Windows journal sharing conflicts.
const heldRead = vi.hoisted(() => ({
  path: '',
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] !== 'string' || args[0] !== heldRead.path || !heldRead.entered)
        return fs.readFile(...args)
      const entered = heldRead.entered
      heldRead.entered = undefined
      const file = await fs.open(args[0], 'r')
      try {
        entered()
        await heldRead.release
        return await file.readFile(args[1])
      } finally {
        await file.close()
      }
    },
  }
})

describe.skipIf(!windows)('MCP journal concurrent reads and commits', () => {
  it('preserves prior data on persistent external sharing failure and recovers the queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-external-reader-'))
    const profile = 'local-dev'
    const store = new McpResourceStore(directory, { allowedProfiles: [profile] })
    let reader: Awaited<ReturnType<typeof open>> | undefined
    try {
      await store.seedLegacyPreset(profile, [])
      const path = join(directory, `${profile}.mcp.json`)
      const previous = await readFile(path, 'utf8')
      reader = await open(path, 'r')
      await expect(store.observeWorker(profile, [])).rejects.toMatchObject({ code: 'EACCES' })
      expect(await readFile(path, 'utf8')).toBe(previous)
      expect(await readdir(directory)).toEqual([`${profile}.mcp.json`])
      await reader.close()
      reader = undefined
      await expect(store.observeWorker(profile, [])).resolves.toBeUndefined()
      expect(await store.workerManaged(profile)).toEqual([])
    } finally {
      await reader?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('waits for an in-flight read handle before replacing the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-held-read-'))
    const profile = 'local-dev'
    const store = new McpResourceStore(directory, { allowedProfiles: [profile] })
    let release = () => {}
    const entered = new Promise<void>((resolve) => {
      heldRead.entered = resolve
    })
    heldRead.release = new Promise<void>((resolve) => {
      release = resolve
    })
    let reading: Promise<unknown> | undefined
    let writing: Promise<unknown> | undefined
    try {
      await store.seedLegacyPreset(profile, [])
      heldRead.path = join(directory, `${profile}.mcp.json`)
      reading = store.workerManaged(profile)
      await entered
      writing = store.observeWorker(profile, [])
      const outcome = writing.then(
        () => undefined,
        (error: unknown) => error,
      )
      // Only the filesystem read is delayed; the replacement is the real Windows operation.
      await new Promise((resolve) => setTimeout(resolve, 100))
      release()
      await reading
      expect(await outcome).toBeUndefined()
    } finally {
      release()
      await Promise.allSettled([reading, writing])
      heldRead.path = ''
      heldRead.entered = undefined
      heldRead.release = undefined
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('keeps repeated reads and worker observations valid without sharing errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-journal-race-'))
    const profile = 'local-dev'
    const store = new McpResourceStore(directory, { allowedProfiles: [profile] })
    const definition = {
      serverId: 'example',
      displayName: 'Example',
      transport: { kind: 'stdio' as const, executable: 'example-mcp', args: [] },
      secretBinding: { kind: 'none' as const },
    }
    try {
      await store.seedLegacyPreset(profile, [definition])
      const failures: unknown[] = []
      for (let round = 0; round < 60; round++) {
        const outcomes = await Promise.allSettled([
          ...Array.from({ length: 12 }, () => store.workerManaged(profile)),
          store.observeWorker(profile, []),
        ])
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') failures.push(outcome.reason)
          else if (outcome.value) expect(outcome.value[0]?.definition).toEqual(definition)
        }
      }
      expect(failures).toEqual([])
      const persisted = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
      expect(persisted.servers.example.definition).toEqual(definition)
      expect(
        await new McpResourceStore(directory, { allowedProfiles: [profile] }).workerManaged(profile),
      ).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
