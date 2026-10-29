import type { LocaleTranslator } from '@agnes/web-ui'

export type ResourceNotice = {
  key?: string
  vars?: Readonly<Record<string, string | number>>
  raw?: string
  kind: string
}

/** List and detail pages display the same refusal, in the current locale. */
export function renderNotice(
  element: HTMLElement,
  notice: ResourceNotice,
  t: LocaleTranslator,
  embedded: boolean,
): string | undefined {
  const text = notice.key ? t(notice.key, notice.vars) : (notice.raw ?? '')
  element.textContent = text
  element.dataset.kind = notice.kind
  element.hidden = embedded && !text
  return notice.kind === 'error' ? text || undefined : undefined
}

export const $ = <K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] => {
  const item = document.getElementById(id)
  if (!item || item.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return item as HTMLElementTagNameMap[K]
}
// Resolved by mountResourceAdmin(). Declared here so the module can be imported without touching the
// DOM; a host that never mounts never triggers a lookup.
