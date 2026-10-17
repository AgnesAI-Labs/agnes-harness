import type { ApplicationState } from '@agnes/protocol'
import {
  applicationBrand,
  applicationIdentity,
  effectiveApplication,
  homeEntries,
  homeNavigation,
  presentationDefault,
  presentationRoles,
} from '@agnes/web-client'
import { safeThemeStorage } from '@agnes/web-foundation/theme'

let urls: string[] = []
let sourceSignature: string | undefined = ''
let titleSuffix = 'Agnes Harness'

export function updateApplicationTitle(): void {
  const prefix = document.title.endsWith(` · ${titleSuffix}`)
    ? document.title.slice(0, -titleSuffix.length)
    : ''
  titleSuffix = applicationBrand(document.documentElement.lang).title
  document.title = prefix + titleSuffix
}
/** Only the host writes head; assets were typed, bounded and hashed by the package owner. */
export function projectApplication(state: ApplicationState | undefined): void {
  const signature = JSON.stringify(state)
  if (signature === sourceSignature) return
  sourceSignature = signature
  const old = urls
  urls = []
  const assets: ApplicationState['assets'] = {}
  for (const key of ['mark', 'favicon'] as const) {
    const data = state?.assets[key]
    if (!data) continue
    const match = /^data:(image\/(?:png|jpeg|webp|gif|x-icon));base64,([A-Za-z0-9+/=]+)$/.exec(data)
    if (!match?.[1] || !match[2]) continue
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
    urls.push(url)
    assets[key] = url
  }
  const projected = state ? { ...state, assets } : undefined
  applicationIdentity.set(projected)
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) {
    icon.href = assets.favicon ?? '/favicon.png'
    icon.type = 'image/png'
  }
  const touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
  if (touch) touch.href = assets.mark ?? '/favicon.png'
  updateApplicationTitle()
  presentationRoles.select(effectiveApplication()?.presentation?.roles)
  for (const url of old) URL.revokeObjectURL(url)
  const requested = homeNavigation.getSnapshot()
  const automatic = (requested?.selection as { applicationDefault?: string } | undefined)?.applicationDefault
  const app = effectiveApplication()
  const home = app?.presentation?.home?.split('#')[1]
  if (automatic && (automatic !== app?.id || requested?.id !== home)) homeNavigation.close()
  openApplicationHome()
}

/** Explicit URL and user page choices are resolved before the application's home default. */
export function openApplicationHome(): void {
  const params = new URLSearchParams(location.search)
  if (params.has('session') || params.has('page') || homeNavigation.getSnapshot()) return
  const app = effectiveApplication()
  let user: string | undefined
  try {
    user = safeThemeStorage().getItem('agnes-home-page') ?? undefined
  } catch {
    /* Preference is optional. */
  }
  const selected = presentationDefault(undefined, user, app?.presentation?.home, '')
  const id = selected.includes('#') ? selected.slice(selected.indexOf('#') + 1) : selected
  if (id && homeEntries.get(id))
    homeNavigation.open(id, user === undefined && app ? { applicationDefault: app.id } : undefined)
}
