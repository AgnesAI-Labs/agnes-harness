import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claimStage, readyStage, recoverStaging } from '../src/staging.js'

it('preserves a live inspector and refuses dead unfinished fetch rather than guessing its children exited', () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-stage-'))
  try {
    const stage = join(root, `.stage-${randomUUID()}`)
    claimStage(stage)
    mkdirSync(stage)
    readyStage(stage)
    recoverStaging(root)
    expect(existsSync(stage)).toBe(true)
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    if (!child.pid) throw Error('missing pid')
    const work = join(root, '.agnes-fetch-abandoned')
    mkdirSync(work)
    writeFileSync(join(work, '.owner'), JSON.stringify({ pid: child.pid, ready: false }))
    expect(() => recoverStaging(root)).toThrow('unfinished source acquisition')
    expect(existsSync(work)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Only this process ever writes an in-process copy, so its dead owner's partial stage is garbage.
// An external fetch may have left children behind, and a marker without a kind predates the field.
it.each([
  ['an in-process copy', 'copy', true],
  ['an external fetch', 'fetch', false],
  ['a marker without a kind', undefined, false],
] as const)(
  'a dead owner of an unready stage holding %s (kind %s) is cleared: %s',
  (_label, kind, cleared) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-stage-kind-'))
    try {
      const stage = join(root, `.stage-${randomUUID()}`)
      mkdirSync(stage)
      writeFileSync(join(stage, 'partial'), 'copied part-way')
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
      if (!child.pid) throw Error('missing pid')
      writeFileSync(
        `${stage}.owner`,
        JSON.stringify({ pid: child.pid, ready: false, ...(kind ? { kind } : {}) }),
      )
      if (cleared) recoverStaging(root)
      else expect(() => recoverStaging(root)).toThrow('unfinished adapter staging')
      expect(existsSync(stage)).toBe(!cleared)
      expect(existsSync(`${stage}.owner`)).toBe(!cleared)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

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
