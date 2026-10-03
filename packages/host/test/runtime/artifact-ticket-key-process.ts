import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { materialBytes, nonceBytes, scanTicketBytes } from './artifact-ticket-key-fixture.js'
import { cleanup, type Kind, scan, scratch } from './network-secrets-fixture.js'

export async function recoverTicketKeys(kind: Kind) {
  const root = scratch()
  const diagnostics: string[] = []
  try {
    for (const [mode, expected] of [
      ['seal', 'sealed-and-rotated'],
      ['open', 'old-opened-new-issued-revoked'],
      ['revoked', 'cold-revocation-refused'],
    ] as const) {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./artifact-ticket-key-child.ts', import.meta.url)),
          kind,
          root,
          mode,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', () => resolve())
      })
      try {
        const line = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Ticket fixture startup timed out')), 10000)
          child.stdout.on('data', (bytes) => {
            stdout += String(bytes)
            if (stdout.includes('\n')) {
              clearTimeout(timer)
              resolve(stdout.slice(0, stdout.indexOf('\n')))
            }
          })
          child.stderr.on('data', (bytes) => {
            stderr += String(bytes)
          })
          child.once('exit', () => {
            clearTimeout(timer)
            reject(new Error(`Ticket fixture exited: ${stderr}`))
          })
          child.once('error', (reason) => {
            clearTimeout(timer)
            reject(reason)
          })
        })
        assert.equal(line, expected)
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        diagnostics.push(stdout, stderr)
      }
      scanTicketBytes(root, diagnostics)
      for (const bytes of [nonceBytes(), materialBytes('v1'), materialBytes('v2')])
        scan(
          root,
          [bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url')],
          diagnostics,
        )
    }
  } finally {
    cleanup(root)
  }
}
