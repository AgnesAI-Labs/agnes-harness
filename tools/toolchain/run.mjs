import { spawn } from 'node:child_process'
import { checkToolchain, pnpmInvocation, root, verificationEnvironment } from './check.mjs'

try {
  const env = verificationEnvironment()
  checkToolchain(env)
  const args = process.argv.slice(2)
  if (args.length) {
    const child = spawn(process.execPath, [...pnpmInvocation(env), ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.once('error', (error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
    child.once('exit', (code, signal) => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
    })
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
