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
