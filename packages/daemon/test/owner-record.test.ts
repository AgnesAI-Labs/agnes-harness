import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OwnerReadError, readOwner } from '../src/supervisor/owner-record.js'

const roots: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-owner-record-'))
  roots.push(dir)
  mkdirSync(join(dir, 'daemon'))
  return { dir, file: join(dir, 'daemon', 'owner.json') }
}
const owner = {
  pid: 42,
  processStartId: 'linux:boot:42:12345',
  generation: '11111111-2222-3333-4444-555555555555',
  startedAt: '2026-09-10T00:00:00.000Z',
  socketPath: '/tmp/agnes.sock',
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('returns null only for an absent owner and preserves a valid record exactly', async () => {
  const { dir, file } = fixture()
  expect(await readOwner(dir)).toBeNull()
  const bytes = JSON.stringify(owner)
  writeFileSync(file, bytes)
  expect(await readOwner(dir)).toEqual(owner)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})
it.each([
  null,
  [],
  {},
  { ...owner, pid: 0 },
  { ...owner, pid: 1.5 },
  { ...owner, generation: 'random' },
  { ...owner, processStartId: '' },
  { ...owner, processStartId: 'PRIVATE\nDATA' },
  { ...owner, startedAt: '2026-02-30T00:00:00.000Z' },
  { ...owner, socketPath: 'relative' },
  { ...owner, credential: 'PRIVATE-MARKER' },
])('rejects malformed owner without treating it as absent', async (value) => {
  const { dir, file } = fixture()
  const bytes = JSON.stringify(value)
  writeFileSync(file, bytes)
  await expect(readOwner(dir)).rejects.toThrow(OwnerReadError)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})
it.each([Buffer.from('{'), Buffer.alloc(4097, 32), Buffer.from([0xff])])(
  'rejects invalid or oversized bytes without deleting them',
  async (bytes) => {
    const { dir, file } = fixture()
    writeFileSync(file, bytes)
    await expect(readOwner(dir)).rejects.toThrow('daemon owner record is unavailable or invalid')
    expect(readFileSync(file)).toEqual(bytes)
  },
)
it('refuses a linked record rather than following or removing its target', async () => {
  const { dir, file } = fixture()
  const target = join(dir, 'target')
  writeFileSync(target, JSON.stringify(owner))
  if (process.platform === 'win32') linkSync(target, file)
  else symlinkSync(target, file)
  await expect(readOwner(dir)).rejects.toThrow(OwnerReadError)
  expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(owner))
})
it('does not interpret a directory at owner.json as absent', async () => {
  const { dir, file } = fixture()
  mkdirSync(file)
  await expect(readOwner(dir)).rejects.toThrow(OwnerReadError)
})
