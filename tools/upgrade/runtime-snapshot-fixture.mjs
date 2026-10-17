import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fixture = fileURLToPath(
  new URL('../../packages/package-manager/test/fixtures/runtime-snapshots-v1/home/', import.meta.url),
)
const read = async (file) => JSON.parse(await readFile(file, 'utf8'))

// This home was written by the actual 877a2c297 writer, including its example-launch trust hash.
// Merge only while the previous daemon is stopped; never replace its existing sessions or pins.
export async function seedRuntimeSnapshotFixture(home) {
  const profile = join(home, 'profiles/local-dev')
  const capturedProfile = join(fixture, 'profiles/local-dev')
  const captured = await read(join(capturedProfile, '.agnes-runtime-snapshots.json'))
  const stateFile = join(profile, '.agnes-runtime-snapshots.json')
  const state = await read(stateFile).catch((error) => {
    if (error.code === 'ENOENT') return { version: 1, snapshots: {}, pins: {} }
    throw error
  })
  const lockFile = join(profile, 'agnes-lock.json')
  const lock = await read(lockFile)
  const capturedLock = await read(join(capturedProfile, 'agnes-lock.json'))
  for (const id of Object.keys(capturedLock.packages)) assert.ok(!Object.hasOwn(lock.packages, id))
  for (const id of Object.keys(captured.pins)) assert.ok(!Object.hasOwn(state.pins, id))
  const packages = join(home, 'data/profiles/local-dev/packages')
  await mkdir(packages, { recursive: true })
  await cp(join(capturedProfile, 'packages'), packages, { recursive: true, force: false, errorOnExist: true })
  Object.assign(lock.packages, capturedLock.packages)
  Object.assign(state.snapshots, captured.snapshots)
  Object.assign(state.pins, captured.pins)
  await writeFile(lockFile, JSON.stringify(lock))
  await writeFile(stateFile, JSON.stringify(state))
  return captured
}

export async function verifyRuntimeSnapshotFixture(home, captured) {
  const current = await read(join(home, 'profiles/local-dev/.agnes-runtime-snapshots.json'))
  const held = new Set(
    Object.values(captured.pins)
      .filter((pin) => pin.purpose === 'turn')
      .map((pin) => pin.snapshotId),
  )
  for (const [id, record] of Object.entries(captured.snapshots)) {
    // Injected active pins without a CompositeTargetStore reference are legitimate GC orphans.
    // Session pins and every retained record must keep their original identity and content.
    if (held.has(id) || current.snapshots[id]) assert.deepEqual(current.snapshots[id], record)
  }
  for (const [id, pin] of Object.entries(captured.pins))
    if (pin.purpose === 'turn' || current.pins[id]) assert.deepEqual(current.pins[id], pin)
  const snapshotId = captured.pins['session-original'].snapshotId
  const module = await import(
    pathToFileURL(join(home, 'data/profiles/local-dev/packages/.runtime-snapshots', snapshotId, 'index.mjs'))
      .href
  )
  assert.equal(module.default(), 'original-v1-bytes')
}
