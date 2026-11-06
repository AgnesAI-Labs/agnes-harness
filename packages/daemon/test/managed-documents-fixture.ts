import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { afterEach, beforeEach } from 'vitest'

let fixture: string | undefined
let documents: string | undefined
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'agnes-managed-documents-'))
  const directory = join(fixture, 'Documents')
  mkdirSync(directory, { mode: 0o700 })
  documents = nativeRealpathSync(directory)
})
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = documents = undefined
})

// Replace only the operating-system Documents lookup; root creation and verification stay real.
export async function fixtureDocumentsDirectory(): Promise<string> {
  if (!documents) throw new Error('Documents fixture is not active')
  return documents
}
