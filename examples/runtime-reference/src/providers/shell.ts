import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ShellProvider } from '@agnes/extension-api/client'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { registerShellContract } from '../../../../packages/extension-api/testkit/runtime/contracts/shell.js'
import { createWorkbenchShell } from '../client/workbench-shell.js'

// Assigning the browser factory here checks its mirrored shapes against the generated types.
const reference: () => ShellProvider = createWorkbenchShell

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

/**
 * Registers the shell cases for the reference workbench shell, reported under `providerId` (the runner
 * passes the name it was asked for, such as `reference`). This package carries no DOM implementation, so
 * the caller supplies `container`, which makes an empty element attached to a document for each mount.
 */
export function bindShellContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{ providerId?: string; container: () => HTMLElement }>,
): void {
  registerShellContract(harness, {
    providerId: options.providerId ?? 'reference.shell',
    recipe: providerFileForContract('agh.shell'),
    command,
    build,
    providerDigest: sha256(new URL('../client/workbench-shell.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({}),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    shell: reference,
    container: options.container,
  })
}
