import { pathToFileURL } from 'node:url'
import { limitCase, terminateActive } from '../../../../packages/host/test/runtime/sandbox-exec-scenarios.js'
import { runConformance } from '../run-conformance.js'
import { qualification } from './sandbox-exec-conformance.js'

export async function runExecutionAcceptance() {
  const stamp = new Date().toISOString()
  const { report } = await runConformance({
    contracts: ['agh.sandbox', 'agh.exec'],
    providers: ['default', 'reference'],
    command: 'tsx tools/acceptance/runtime/platform/execution.ts',
    clock: { startedAt: stamp, finishedAt: stamp },
    reportPath: null,
  })
  const limits = []
  const darwin = process.platform === 'darwin' // guards-allow-platform: real platform qualification
  if (darwin) {
    for (const kind of ['default', 'reference'] as const) {
      for (const field of [
        'cpuMs',
        'wallMs',
        'memoryBytes',
        'outputBytes',
        'processes',
        'openFiles',
      ] as const)
        limits.push({ kind, field, metrics: await limitCase(kind, field) })
      for (const operation of ['cancel', 'release', 'stop', 'dispose'] as const)
        await terminateActive(kind, operation)
    }
  }
  process.stdout.write(
    JSON.stringify({ status: report.status, assertions: report.assertions.length, qualification, limits }) +
      '\n',
  )
  return report.status === 'passed' ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runExecutionAcceptance().then(
    (code) => {
      process.exitCode = code
    },
    (problem) => {
      console.error(problem)
      process.exitCode = 1
    },
  )
