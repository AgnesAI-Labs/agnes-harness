import { existsSync, readFileSync, writeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { AuthorityDirectoryCompareAndSwapRequest, StateAuthorityRef } from '@agnes/protocol/runtime'
import {
  createReferenceAuthorityDirectory,
  openReferenceAnchor,
} from '../../../../examples/runtime-reference/src/providers/authority-directory.ts'
import {
  type BootstrapLocator,
  openBootstrapAnchor,
} from '../../../../packages/host/src/runtime/maintenance/bootstrap-locator.ts'
import {
  createAuthorityDirectoryProvider,
  type DurabilityPhase,
} from '../../../../packages/host/src/runtime/providers/authority-directory.ts'

interface Payload {
  readonly implementation: 'default' | 'reference'
  readonly authority: StateAuthorityRef
  readonly principalRef: string
  readonly phase: DurabilityPhase | 'transaction' | null
  readonly locatorPublication?: { readonly expectedRevision: number; readonly next: BootstrapLocator }
  readonly request: AuthorityDirectoryCompareAndSwapRequest
}

function context(principalRef: string): CallContext {
  return {
    principalRef,
    scope: { kind: 'installation', installationId: 'install-1' },
    bindingId: 'binding-1',
    invocationId: 'invoke-1',
    deadline: '2099-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'authz-1',
    signal: new AbortController().signal,
  }
}

function open(payload: Payload, directory: string, anchor: string) {
  const onPhase = (phase: string) => {
    if (payload.phase !== null && phase === payload.phase) {
      // Stop inside the synchronous persistence hook until the parent observes it and kills us.
      writeSync(1, `PHASE ${phase}\n`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  }
  if (payload.implementation === 'default') {
    return createAuthorityDirectoryProvider({
      directory,
      anchor,
      authority: payload.authority,
      onPhase,
    })
  }
  return createReferenceAuthorityDirectory({
    directory,
    anchor,
    authority: payload.authority,
    onPhase,
  })
}

async function waitForGo(goPath: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(goPath)) {
    if (Date.now() > deadline) throw new Error('go file was not published')
    await delay(20)
  }
}

async function main(): Promise<void> {
  const [mode, directory, anchor, payloadPath, goPath] = process.argv.slice(2)
  if (mode === undefined || directory === undefined || anchor === undefined || payloadPath === undefined) {
    throw new Error(
      'usage: authority-directory-process <kill|race|recover> <directory> <anchor> <payload> [go]',
    )
  }
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as Payload
  const provider = open(payload, directory, anchor)
  if (mode === 'race') {
    if (goPath === undefined) throw new Error('race requires a go file')
    process.stdout.write('READY\n')
    await waitForGo(goPath)
    const openedAnchor = payload.locatorPublication
      ? payload.implementation === 'default'
        ? openBootstrapAnchor(anchor)
        : openReferenceAnchor(anchor)
      : null
    const outcome =
      payload.locatorPublication && openedAnchor
        ? openedAnchor.ok
          ? openedAnchor.value.compareAndSwap(
              payload.locatorPublication.expectedRevision,
              payload.locatorPublication.next,
            )
          : openedAnchor
        : await provider.compareAndSwap(payload.request, context(payload.principalRef))
    process.stdout.write(outcome.ok ? 'WIN\n' : `LOSE ${outcome.error.code}/${outcome.error.detailCode}\n`)
    return
  }
  if (mode === 'recover') {
    const outcome = await provider.compareAndSwap(payload.request, context(payload.principalRef))
    await provider.dispose()
    process.stdout.write(JSON.stringify(outcome))
    return
  }
  if (mode === 'kill') {
    const outcome = await provider.compareAndSwap(payload.request, context(payload.principalRef))
    process.stdout.write(
      outcome.ok ? 'SURVIVED\n' : `REFUSED ${outcome.error.code}/${outcome.error.detailCode}\n`,
    )
    return
  }
  throw new Error(`unknown mode ${mode}`)
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : 'authority directory process failed'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
