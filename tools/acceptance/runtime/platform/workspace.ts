import { pathToFileURL } from 'node:url'
import { proveRemoteWorkspace } from '../fixtures/remote-workspace.ts'
import { runConformance } from '../run-conformance.ts'

export async function runWorkspaceAcceptance(command: string): Promise<number> {
  await proveRemoteWorkspace()
  const stamp = '2026-10-02T00:00:00.000Z'
  const { report } = await runConformance({
    contracts: ['agh.workspace', 'agh.files'],
    providers: ['default', 'reference'],
    command,
    clock: { startedAt: stamp, finishedAt: stamp },
    reportPath: null,
  })
  process.stdout.write(`${report.status} ${report.assertions.length}\n`)
  for (const failure of report.failures) process.stderr.write(`${failure.code} ${failure.detail}\n`)
  return report.status === 'passed' ? 0 : 1
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  runWorkspaceAcceptance('tsx tools/acceptance/runtime/platform/workspace.ts').then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'workspace acceptance failed'}\n`)
      process.exitCode = 1
    },
  )
}
