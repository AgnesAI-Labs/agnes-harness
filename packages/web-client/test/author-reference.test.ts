import { readFileSync } from 'node:fs'
import { CLIENT_PLATFORM_IMPORTS } from '@agnes/protocol'
import { expect, expectTypeOf, it } from 'vitest'
import type { ClientContext, ClientProfileServices, HomeEntry } from '../src/index.js'

// Compile the reference's usage at the public boundary, including optional operation-read scopes.
function documentedBrowserCalls(ctx: ClientContext, entry: HomeEntry) {
  const off: () => void = ctx.homeEntries.register(entry)
  const query: Promise<unknown> = ctx.profile.services.query('todo.list', {}, { sessionReads: [] })
  const effect: Promise<unknown> = ctx.profile.services.effect(
    'todo.change',
    { action: 'add', text: 'one' },
    { operationId: 'one' },
  )
  const receipt: Promise<unknown> = ctx.profile.services.readOperation('todo.change', 'one')
  const sessionEffect: Promise<unknown> = ctx.agnes.services.effect(
    'page.control',
    {},
    { operationId: 'session-one' },
  )
  const sessionStream = ctx.sessionStreams.open('page.frames', { pageId: 'one' })
  return { off, query, effect, receipt, sessionEffect, sessionStream }
}

it('agrees with the generated browser API reference and Host import map', async () => {
  expectTypeOf<ClientContext['profile']['services']>().toEqualTypeOf<ClientProfileServices>()
  expectTypeOf(documentedBrowserCalls).toBeFunction()
  const { authorContract, authorReference } = await import(
    new URL(
      '../../package-manager/bundled-plugins/plugin-helper/src/reference.generated.mjs',
      import.meta.url,
    ).href
  )
  expect(authorContract.browserImports).toEqual([...CLIENT_PLATFORM_IMPORTS])
  expect(authorContract.browserServices.map((text: string) => /^(\w+)\(/.exec(text)?.[1])).toEqual([
    'query',
    'effect',
    'readOperation',
  ])
  expect(authorContract.browserContext.join('\n')).toContain('scopedHomeEntries')
  expect(authorReference).toContain('There is no ctx.tools.invoke from the browser')
  expect(authorReference).toContain('Never search Host/installed source')
  expect(authorReference).toContain(
    'fs is policy-controlled WORKSPACE access, never a private plugin directory',
  )
  const { outputs } = await import(new URL('../../../tools/authoring/reference.mjs', import.meta.url).href)
  for (const [path, expected] of Object.entries(outputs()))
    expect(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')).toBe(expected)
})
