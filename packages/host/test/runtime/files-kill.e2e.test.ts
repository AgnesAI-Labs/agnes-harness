import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import { describe, expect, it } from 'vitest'
import {
  BODY,
  callFor,
  FILE_NAME,
  type Kind,
  loadProfile,
  openFiles,
  type RenamedReport,
  saveProfile,
  TAMPERED,
} from './files-kill-fixture.js'

const childPath = fileURLToPath(new URL('./files-kill-child.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../..', import.meta.url))
const emptyDigest = createHash('sha256').update('').digest('hex')
const bodyDigest = createHash('sha256').update(BODY).digest('hex')

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'files-kill-'))
  mkdirSync(join(directory, 'work'))
  mkdirSync(join(directory, 'home'))
  mkdirSync(join(directory, 'data'))
  saveProfile(directory)
  return directory
}

function isReport(message: unknown): message is RenamedReport {
  return (
    typeof message === 'object' && message !== null && (message as { stage?: string }).stage === 'renamed'
  )
}

function killAfterRename(kind: Kind, directory: string): Promise<RenamedReport> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', childPath, kind, directory], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stderr = ''
    let report: RenamedReport | undefined
    let receipt = false
    let content = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (report) resolve(report)
      else reject(new Error('missing rename report'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`files child timed out\n${stderr}`))
    }, 15_000)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { stage?: string }).stage === 'receipt'
      )
        receipt = true
      if (!isReport(message) || report) return
      report = message
      try {
        content = readFileSync(join(directory, 'work', message.path), 'utf8')
      } catch (error) {
        content = error instanceof Error ? error.message : 'unreadable'
      }
      child.kill('SIGKILL')
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (signal === 'SIGKILL' && report && !receipt && content === BODY) finish()
      else
        finish(
          new Error(
            `files child closed code=${code ?? 'null'} signal=${signal ?? 'null'} ` +
              `receipt=${String(receipt)} content=${content}\n${stderr}`,
          ),
        )
    })
  })
}

function request(report: RenamedReport) {
  return {
    mountRef: report.mountRef,
    path: report.path,
    bytesRef: report.bytesRef,
    expectedVersion: { kind: 'absent' as const },
  }
}

function detail(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : outcome.error.detailCode
}

// POSIX SIGKILL after rename and before the caller receives the receipt. Windows is not covered.
describe.skipIf(process.platform === 'win32')('file write killed after rename', () => {
  it.each(['default', 'reference'] as const)(
    'returns the original %s result when the durable bytes still match',
    async (kind) => {
      const directory = scratch()
      try {
        const report = await killAfterRename(kind, directory)
        const file = join(directory, 'work', report.path)
        const before = statSync(file)
        const opened = openFiles(kind, directory)
        try {
          const context = callFor(loadProfile(directory), report.invocationId)
          const body = request(report)
          const recovered = await opened.files.write(body, context)
          expect(recovered.ok, detail(recovered)).toBe(true)
          if (!recovered.ok) return
          expect(recovered.value.version).toBe(1)
          expect(recovered.value.digest).toBe(bodyDigest)
          expect(recovered.value.checkpoint).toMatchObject({
            requestId: report.invocationId,
            path: FILE_NAME,
            before: 'absent',
            beforeVersion: null,
            digest: emptyDigest,
          })
          expect(statSync(file).ino).toBe(before.ino)
          expect(readFileSync(file, 'utf8')).toBe(BODY)
          expect(readdirSync(join(directory, 'work')).sort()).toEqual([FILE_NAME])
          const replay = await opened.files.write(body, context)
          expect(replay).toEqual(recovered)
          expect(statSync(file).ino).toBe(before.ino)
          writeFileSync(file, TAMPERED)
          const tampered = statSync(file)
          const refused = await opened.files.write(body, context)
          expect(detail(refused)).toBe('effect_unknown')
          expect(refused.ok).toBe(false)
          if (!refused.ok) expect(refused.error.retryAdvice.kind).toBe('reconcile')
          expect(readFileSync(file, 'utf8')).toBe(TAMPERED)
          expect(statSync(file).ino).toBe(tampered.ino)
          expect(readdirSync(join(directory, 'work')).sort()).toEqual([FILE_NAME])
        } finally {
          opened.close()
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    20_000,
  )

  it.each(['default', 'reference'] as const)(
    'does not overwrite a %s file when the killed bytes no longer match',
    async (kind) => {
      const directory = scratch()
      try {
        const report = await killAfterRename(kind, directory)
        const file = join(directory, 'work', report.path)
        writeFileSync(file, TAMPERED)
        const tampered = statSync(file)
        const opened = openFiles(kind, directory)
        try {
          const refused = await opened.files.write(
            request(report),
            callFor(loadProfile(directory), report.invocationId),
          )
          expect(detail(refused)).toBe('effect_unknown')
          expect(refused.ok).toBe(false)
          if (!refused.ok) expect(refused.error.retryAdvice.kind).toBe('reconcile')
          expect(readFileSync(file, 'utf8')).toBe(TAMPERED)
          expect(statSync(file).ino).toBe(tampered.ino)
          expect(readdirSync(join(directory, 'work')).sort()).toEqual([FILE_NAME])
        } finally {
          opened.close()
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    20_000,
  )
})
