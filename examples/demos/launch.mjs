import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export async function launch(name) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./scenarios.mjs', import.meta.url)),
      name,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  )
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  const code = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
  process.exitCode = code ?? 1
}
