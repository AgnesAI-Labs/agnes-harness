import type { SecretConsumerBinding } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  boundary,
  cleanup,
  consumer,
  error,
  must,
  resolveInput,
  scope,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

const purposes: SecretConsumerBinding['consumer'][] = ['exec', 'artifact-ticket']
it.each(purposes)('does not grant %s access by registering its name', async (purpose) => {
  const directory = scratch()
  const auth = boundary()
  const broker = secrets('default', directory, auth)
  try {
    const handle = must(await broker.resolve(resolveInput, auth.call()))
    let reads = 0
    const result = await broker.use(handle, { ...consumer, consumer: purpose }, auth.call(), () => {
      reads++
    })
    expect(error(result)).toBe('denied/secret_consumer')
    expect(reads).toBe(0)
    expect(error(await broker.resolve({ ...resolveInput, purpose: 'unselected' }, auth.call()))).toBe(
      'denied/secret_denied',
    )
  } finally {
    await broker.close()
    cleanup(directory)
  }
})
it.each(purposes)('still requires the selected full %s binding and current scope', async (purpose) => {
  const directory = scratch()
  const auth = boundary()
  const selected: SecretConsumerBinding = { ...consumer, consumer: purpose }
  const broker = secrets('default', directory, auth, {
    grants: [{ principalRef: 'actor', scope, binding: selected }],
  })
  try {
    const handle = must(await broker.resolve(resolveInput, auth.call()))
    let reads = 0
    must(
      await broker.use(handle, selected, auth.call(), () => {
        reads++
      }),
    )
    expect(reads).toBe(1)
    expect(
      error(
        await broker.use(
          handle,
          selected,
          auth.call({
            scope: {
              kind: 'workspace',
              installationId: 'install',
              runtimeId: 'runtime',
              workspaceId: 'foreign',
            },
          }),
          () => {
            reads++
          },
        ),
      ),
    ).toBe('denied/secret_denied')
    expect(reads).toBe(1)
  } finally {
    await broker.close()
    cleanup(directory)
  }
})
