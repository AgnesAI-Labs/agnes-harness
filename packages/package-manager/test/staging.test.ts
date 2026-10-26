import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { PackageRecoveryEvent } from '../src/recovery-log.js'
import {
  ABANDONED_AFTER_MS,
  claimStage,
  readyStage,
  recoverProfileStaging,
  recoverStaging,
} from '../src/staging.js'

const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  if (!child.pid) throw Error('missing pid')
  return child.pid
}
const later = () => Date.now() + ABANDONED_AFTER_MS + 1000

it('keeps a live inspector, and keeps a dead fetch while it may still be written, then removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    claimStage(stage)
    mkdirSync(stage)
    readyStage(stage)
    const events: PackageRecoveryEvent[] = []
    recoverStaging(root, (event) => events.push(event), later())
    expect(existsSync(stage)).toBe(true)
    const work = join(root, '.agnes-fetch-abandoned')
    mkdirSync(work)
    writeFileSync(join(work, '.owner'), JSON.stringify({ pid: deadPid(), ready: false }))
    // An orphaned child of the dead fetch may still write here: skipped, never a refusal.
    recoverStaging(root, (event) => events.push(event))
    expect(existsSync(work)).toBe(true)
    expect(events).toEqual([])
    recoverStaging(root, (event) => events.push(event), later())
    expect(existsSync(work)).toBe(false)
    expect(existsSync(stage)).toBe(true)
    expect(events).toEqual([{ action: 'removed', path: work, reason: 'fetch-outcome-unknown' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Only this process ever writes an in-process copy, so its dead owner's partial stage is garbage at
// once. An external fetch may have left children behind, and a marker without a kind predates the
// field: those wait until nothing in them has changed for ABANDONED_AFTER_MS.
it.each([
  ['an in-process copy', 'copy', true],
  ['an external fetch', 'fetch', false],
  ['a marker without a kind', undefined, false],
] as const)(
  'a dead owner of an unready stage holding %s (kind %s) is cleared at once: %s',
  (_label, kind, atOnce) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-stage-kind-'))
    try {
      const stage = join(root, `.stage-${randomUUID()}`)
      mkdirSync(stage)
      writeFileSync(join(stage, 'partial'), 'copied part-way')
      writeFileSync(
        `${stage}.owner`,
        JSON.stringify({ pid: deadPid(), ready: false, ...(kind ? { kind } : {}) }),
      )
      recoverStaging(root)
      expect(existsSync(stage)).toBe(!atOnce)
      expect(existsSync(`${stage}.owner`)).toBe(!atOnce)
      recoverStaging(root, () => {}, later())
      expect(existsSync(stage)).toBe(false)
      expect(existsSync(`${stage}.owner`)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('removes a quiet stage without an owner and records it in the profile recovery log', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-unowned-')),
    profile = mkdtempSync(join(tmpdir(), 'agnes-stage-profile-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    mkdirSync(stage)
    const old = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000)
    utimesSync(stage, old, old)
    recoverProfileStaging(root, profile)
    expect(existsSync(stage)).toBe(false)
    const log = readFileSync(join(profile, '.agnes-package-recovery.jsonl'), 'utf8').trim().split('\n')
    expect(log.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ action: 'removed', path: stage, reason: 'staging-owner-unknown' }),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

it('names the owner file and the repair when a staging owner is invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-invalid-'))
  try {
    const owner = join(root, `.stage-${randomUUID()}.owner`)
    writeFileSync(owner, JSON.stringify({ pid: 'nope', ready: false }))
    expect(() => recoverStaging(root)).toThrow(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: 'staging-owner-invalid', path: owner }),
      }),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('does not rewrite a sidecar belonging to an unrelated fetch destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-sidecar-')),
    target = join(root, 'output')
  try {
    writeFileSync(`${target}.owner`, 'user data')
    readyStage(target)
    expect(readFileSync(`${target}.owner`, 'utf8')).toBe('user data')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
