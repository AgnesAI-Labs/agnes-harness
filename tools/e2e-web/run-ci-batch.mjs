import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalBatch } from '../ci/web-matrix.mjs'

export function batchInvocation(value, argv, env = process.env) {
  if (argv.length !== 2 || argv[0] !== '--prepared-local' || !argv[1] || argv[1].startsWith('-'))
    throw new Error('Expected --prepared-local <directory>')
  const batch = canonicalBatch(JSON.parse(value))
  return {
    command: process.execPath,
    args: ['tools/e2e-web/ci.mjs', 'test', ...argv, ...batch.args, '--workers=1'],
    env: { ...env, AGH_NARROW_WIDTHS: batch.widths, AGH_WEB_TEST_OUTPUT: `.agnes-tmp/e2e-web/${batch.id}` },
  }
}

export function runBatch(invocation, start = spawn) {
  return new Promise((done, reject) => {
    const child = start(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: 'inherit',
      shell: false,
    })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    const cleanup = () => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      done({ code, signal })
    })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = batchInvocation(process.env.CI_WEB_BATCH, process.argv.slice(2))
    const { code, signal } = await runBatch(invocation)
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
