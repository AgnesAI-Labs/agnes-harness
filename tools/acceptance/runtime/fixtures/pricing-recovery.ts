import { type ChildProcess, fork } from 'node:child_process'
import type { PricingRecoveryObservation } from '../../../../packages/extension-api/testkit/runtime/contracts/pricing.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'

type Kind = 'default' | 'reference'
type Proof = Pick<PricingRecoveryObservation, 'input' | 'output' | 'catalogDigest'> & { pid: number }

function proof(child: ChildProcess): Promise<Proof> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(Error('Pricing recovery worker timed out')), 30000)
    let stderr = ''
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== 'object' || typeof (value as Proof).pid !== 'number')
        done(Error('Invalid pricing recovery IPC'))
      else done(undefined, value as Proof)
    }
    const onExit = () => done(Error(`Pricing recovery worker exited before proof: ${stderr}`))
    const onError = (error: Error) => done(error)
    const onStderr = (part: Buffer) => {
      stderr = (stderr + part.toString()).slice(-4096)
    }
    function done(error?: Error, value?: Proof) {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
      child.stderr?.off('data', onStderr)
      if (error) reject(error)
      else if (value) resolve(value)
    }
    child.once('message', onMessage)
    child.once('exit', onExit)
    child.once('error', onError)
    child.stderr?.on('data', onStderr)
  })
}

function launch(kind: Kind, databasePath: string, phase: 'hold' | 'read', providerId?: string): ChildProcess {
  return fork(
    new URL('./pricing-recovery-worker.ts', import.meta.url),
    [kind, databasePath, phase, providerId ?? 'fixture.pricing'],
    {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  )
}

function exit(child: ChildProcess): Promise<{ signal: NodeJS.Signals | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ signal: child.signalCode, code: child.exitCode })
      return
    }
    const timer = setTimeout(() => reject(Error('Pricing recovery worker exit timed out')), 15000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ signal, code })
    })
  })
}

export async function recoverPricingInFreshProcess(
  kind: Kind,
  databasePath: string,
  providerId?: string,
): Promise<PricingRecoveryObservation> {
  const original = launch(kind, databasePath, 'hold', providerId)
  let fresh: ChildProcess | undefined
  try {
    const first = await proof(original)
    if (!original.kill('SIGKILL')) throw Error('Failed to physically kill pricing worker')
    const killed = await exit(original)
    if (killed.signal !== 'SIGKILL') throw Error('Pricing worker was not killed')
    fresh = launch(kind, databasePath, 'read', providerId)
    const second = await proof(fresh)
    const finished = await exit(fresh)
    if (finished.code !== 0 || finished.signal !== null) throw Error('Fresh pricing worker failed')
    if (
      first.pid === second.pid ||
      first.catalogDigest !== second.catalogDigest ||
      canonicalJsonDigest(first.input) !== canonicalJsonDigest(second.input) ||
      canonicalJsonDigest(first.output) !== canonicalJsonDigest(second.output)
    )
      throw Error('Pricing recovery source changed')
    return {
      originalPid: first.pid,
      freshPid: second.pid,
      originalExitSignal: 'SIGKILL',
      input: second.input,
      output: second.output,
      catalogDigest: second.catalogDigest,
    }
  } finally {
    if (original.exitCode === null && original.signalCode === null) original.kill('SIGKILL')
    if (fresh && fresh.exitCode === null && fresh.signalCode === null) fresh.kill('SIGKILL')
  }
}
