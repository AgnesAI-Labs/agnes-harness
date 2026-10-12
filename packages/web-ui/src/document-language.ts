import { useStoreSelector } from './external-store.js'

const languages = new WeakMap<Document, ReturnType<typeof documentLanguage>>()
function documentLanguage(owner: Document) {
  const listeners = new Set<() => void>()
  const observer = new MutationObserver(() => {
    for (const listener of listeners) listener()
  })
  return {
    getSnapshot: () => owner.documentElement.lang,
    subscribe(listener: () => void) {
      if (!listeners.size)
        observer.observe(owner.documentElement, { attributes: true, attributeFilter: ['lang'] })
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) observer.disconnect()
      }
    },
  }
}
export function useDocumentLanguage(owner = document) {
  let language = languages.get(owner)
  if (!language) {
    language = documentLanguage(owner)
    languages.set(owner, language)
  }
  return useStoreSelector(language, (value) => value)
}
