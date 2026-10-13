/** @vitest-environment happy-dom */
import type { SessionRuntimeDescriptor } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { RuntimeInfo } from '../src/session-runtime-dialog.js'
import { enT } from './helpers/locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const descriptor = (id: string | undefined) =>
  ({
    sessionKey: 's',
    loaded: true,
    generation: { id, current: false },
    providers: [],
    seams: [],
    restartRequired: [],
  }) as unknown as SessionRuntimeDescriptor

it('says that plugin panels and views are not pinned by the session generation', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(RuntimeInfo, { runtime: descriptor('gen-1'), t: enT })))
  expect(host.textContent).toContain(enT('session.runtime.clientLive'))
  await act(async () => root.render(createElement(RuntimeInfo, { runtime: descriptor(undefined), t: enT })))
  expect(host.textContent).not.toContain(enT('session.runtime.clientLive'))
  await act(async () => root.unmount())
  host.remove()
})
