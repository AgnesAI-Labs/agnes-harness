import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolsColdProof } from '../../../../packages/extension-api/testkit/runtime/contracts/tools.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'

interface Message {
  phase: string
  pid: number
  proof: string
  inputDigest: string
  configurationDigest: string
}
async function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Tools cold child kill timed out')), 15000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
    if (!child.kill('SIGKILL')) {
      clearTimeout(timer)
      reject(new Error('Tools cold child kill refused'))
    }
  })
}
function message(child: ChildProcess): Promise<Message> {
  return new Promise((resolveMessage, reject) => {
    let errors = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Tools cold process timed out: ${errors}`))
    }, 30000)
    const receive = (data: unknown) => {
      cleanup()
      if (!data || typeof data !== 'object' || !('proof' in data) || !('pid' in data))
        reject(new Error('Invalid Tools cold IPC proof'))
      else resolveMessage(data as Message)
    }
    const exit = () => {
      cleanup()
      reject(new Error(`Tools cold process exited before proof: ${errors}`))
    }
    const error = (reason: Error) => {
      cleanup()
      reject(reason)
    }
    const stderr = (data: Buffer) => {
      errors = (errors + data.toString()).slice(-4096)
    }
    function cleanup() {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('exit', exit)
      child.off('error', error)
      child.stderr?.off('data', stderr)
    }
    child.once('message', receive)
    child.once('exit', exit)
    child.once('error', error)
    child.stderr?.on('data', stderr)
  })
}
/** Stateless pure recomputation proof, deliberately not a persisted Action receipt. */
export async function toolsColdRecovery(kind: 'default' | 'reference'): Promise<ToolsColdProof> {
  const directory = mkdtempSync(join(tmpdir(), 'tools-pure-cold-')),
    children: ChildProcess[] = []
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('tools-pure-cold-'))
    throw new Error('Tools cold cleanup target differs')
  try {
    const seed = { kind, text: 'hello 皇上\r\n🙂 second' },
      sourceFile = join(directory, 'source.json'),
      resultFile = join(directory, 'pure-result.json')
    writeFileSync(sourceFile, JSON.stringify({ ...seed, digest: canonicalJsonDigest(seed) }), { flag: 'wx' })
    const run = (phase: string) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL(
              '../../../../packages/core/test/runtime/fixtures/tools-recovery-worker.ts',
              import.meta.url,
            ),
          ),
          phase,
          sourceFile,
          resultFile,
        ],
        {
          cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C' },
        },
      )
      children.push(child)
      return child
    }
    const first = run('first'),
      original = await message(first)
    if (original.phase !== 'first' || original.pid !== first.pid || first.exitCode !== null)
      throw new Error('Tools first live PID proof differs')
    const source = readFileSync(sourceFile),
      result = readFileSync(resultFile)
    await killed(first)
    const second = run('recover'),
      recovered = await message(second)
    if (
      recovered.phase !== 'recover' ||
      recovered.pid !== second.pid ||
      recovered.pid === original.pid ||
      recovered.proof !== original.proof ||
      !readFileSync(sourceFile).equals(source) ||
      !readFileSync(resultFile).equals(result)
    )
      throw new Error('Tools cold recovery changed the original fixed source/result')
    return {
      firstPid: original.pid,
      recoveredPid: recovered.pid,
      original: original.proof,
      recovered: recovered.proof,
      inputDigest: original.inputDigest,
      configurationDigest: original.configurationDigest,
    }
  } finally {
    await Promise.all(children.map(killed))
    rmSync(directory, { recursive: true, force: true })
  }
}
