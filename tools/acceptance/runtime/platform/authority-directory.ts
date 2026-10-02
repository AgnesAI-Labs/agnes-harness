import { pathToFileURL } from 'node:url'
import { proveDirectoryAgreement } from './authority-directory-conformance.ts'

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  proveDirectoryAgreement().then(
    (report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`)
    },
    (error: unknown) => {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : 'authority directory acceptance failed'
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    },
  )
}
