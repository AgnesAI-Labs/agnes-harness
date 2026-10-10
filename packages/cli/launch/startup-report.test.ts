import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStartupReport, reportStartupFailure, startupReason } from './startup-report.js'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('startupReason', () => {
  it.each([
    ['Private directory validation failed', 'Private directory validation failed'],
    ['  spaced\tout\r\nacross lines  ', 'spaced out across lines'],
    ['bell\u0007 and \u001b[31mcolour\u001b[0m and del\u007f', 'bell and [31mcolour [0m and del'],
    ['', undefined],
    ['  \n\t ', undefined],
  ])('turns %j into %j', (input, expected) => {
    expect(startupReason(input)).toBe(expected)
  })

  it('cuts a long reason and marks the cut', () => {
    const reason = startupReason('x'.repeat(1_000))
    expect(reason).toBe(`${'x'.repeat(300)}…`)
  })
})

describe('the file the launcher gives a daemon child', () => {
  it('is a private temporary directory the child can write a reason into and the launcher can read', () => {
    const report = createStartupReport()
    if (!report) throw new Error('no report')
    const file = report.env.AGNES_DAEMON_STARTUP_REPORT as string
    cleanup.push(dirname(file))
    expect(dirname(dirname(file))).toBe(tmpdir())
    expect(basename(dirname(file))).toMatch(/^agh-daemon-start-/)
    expect(report.read()).toBeUndefined()
    reportStartupFailure('Private directory validation failed', report.env)
    expect(report.read()).toBe('Private directory validation failed')
    report.dispose()
    expect(existsSync(dirname(file))).toBe(false)
    expect(report.read()).toBeUndefined()
    expect(() => report.dispose()).not.toThrow()
  })

  it('hands out a different directory each time', () => {
    const first = createStartupReport()
    const second = createStartupReport()
    try {
      expect(first?.env.AGNES_DAEMON_STARTUP_REPORT).not.toBe(second?.env.AGNES_DAEMON_STARTUP_REPORT)
    } finally {
      first?.dispose()
      second?.dispose()
    }
  })

  it('reads at most a few kilobytes of what a child wrote', () => {
    const report = createStartupReport()
    if (!report) throw new Error('no report')
    try {
      writeFileSync(report.env.AGNES_DAEMON_STARTUP_REPORT as string, 'y'.repeat(1_000_000))
      expect(report.read()?.length).toBeLessThanOrEqual(301)
    } finally {
      report.dispose()
    }
  })
})

describe('reportStartupFailure', () => {
  const place = (directoryName: string, fileName: string) => {
    const directory = mkdtempSync(join(tmpdir(), directoryName))
    cleanup.push(directory)
    return join(directory, fileName)
  }

  it("writes only to the file the launcher named, and only in the launcher's own layout", () => {
    const ok = place('agh-daemon-start-', 'startup-failure.txt')
    reportStartupFailure('reason', { AGNES_DAEMON_STARTUP_REPORT: ok })
    expect(readFileSync(ok, 'utf8')).toBe('reason')

    for (const target of [
      place('somewhere-else-', 'startup-failure.txt'),
      place('agh-daemon-start-', 'other-name.txt'),
      'relative/agh-daemon-start-x/startup-failure.txt',
      '',
    ]) {
      reportStartupFailure('reason', { AGNES_DAEMON_STARTUP_REPORT: target })
      expect(existsSync(target) && target !== '' ? readFileSync(target, 'utf8') : '').toBe('')
    }
  })

  it('does nothing without the variable, for an empty reason, or when the directory is gone', () => {
    expect(() => reportStartupFailure('reason', {})).not.toThrow()
    const ok = place('agh-daemon-start-', 'startup-failure.txt')
    reportStartupFailure('  ', { AGNES_DAEMON_STARTUP_REPORT: ok })
    expect(existsSync(ok)).toBe(false)
    const gone = join(tmpdir(), 'agh-daemon-start-missing', 'startup-failure.txt')
    expect(() => reportStartupFailure('reason', { AGNES_DAEMON_STARTUP_REPORT: gone })).not.toThrow()
    expect(existsSync(dirname(gone))).toBe(false)
  })

  it('does not follow a directory that is not there to create it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agh-daemon-start-'))
    cleanup.push(parent)
    const nested = join(parent, 'nested', 'startup-failure.txt')
    mkdirSync(dirname(parent), { recursive: true })
    reportStartupFailure('reason', { AGNES_DAEMON_STARTUP_REPORT: nested })
    expect(existsSync(dirname(nested))).toBe(false)
  })
})
