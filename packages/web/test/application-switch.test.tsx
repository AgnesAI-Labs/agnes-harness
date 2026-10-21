/** @vitest-environment happy-dom */
import { applicationIdentity } from '@agnes/web-client'
import { mountRegion, unmountRegion } from '@agnes/web-ui'
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import { ApplicationSwitch } from '../src/regions/application-switch.js'
import { zhLocaleService } from './helpers/locale.js'

const adopted = {
  revision: 2,
  status: 'active' as const,
  selection: {
    packageId: 'fixture/app',
    applicationId: 'fixture',
    integrity: `sha256-${'a'.repeat(64)}`,
    declarationDigest: 'b'.repeat(64),
    consentDigest: 'c'.repeat(64),
    bindingDigest: 'd'.repeat(64),
  },
  effective: null,
  candidates: [],
  assets: {},
}

afterEach(() => {
  applicationIdentity.set(undefined)
  document.body.replaceChildren()
})

it('asks the host to open the settings page in place while keeping the href as the fallback', () => {
  applicationIdentity.set(adopted)
  const host = document.createElement('div')
  document.body.append(host)
  mountRegion(host, createElement(ApplicationSwitch, { locale: zhLocaleService() }))
  const link = host.querySelector<HTMLAnchorElement>('[data-testid="application-switch"]')
  if (!link) throw new Error('application switch is missing')
  const requests: CustomEvent[] = []
  const hostHandler = (event: Event) => {
    requests.push(event as CustomEvent)
    event.preventDefault()
  }
  window.addEventListener('agnes:open-settings', hostHandler)
  try {
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    expect(link.dispatchEvent(plain)).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.detail).toEqual({ section: 'application' })
    expect(plain.defaultPrevented).toBe(true)
    // Modifier clicks leave the href to the browser, so a new tab still opens the settings page.
    link.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true }),
    )
    expect(requests).toHaveLength(1)
  } finally {
    window.removeEventListener('agnes:open-settings', hostHandler)
    unmountRegion(host)
  }
})
