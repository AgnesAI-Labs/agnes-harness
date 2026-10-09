export const $ = <K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] => {
  const item = document.getElementById(id)
  if (!item || item.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return item as HTMLElementTagNameMap[K]
}
// Resolved by mountResourceAdmin(). Declared here so the module can be imported without touching the
// DOM; a host that never mounts never triggers a lookup.
