import { pathToFileURL } from 'node:url'
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
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      assertions: report.assertions.length,
      qualification,
      normal: 'incomplete',
      recover: 'incomplete',
    })}\n`,
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
