import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function localeKeys(
  folders = [
    'packages/web/src/locales',
    'packages/web/src/admin/plugins/locales',
    'packages/web/src/settings',
    'packages/web-units/src',
    'packages/resource-control-web/src/locales',
    'packages/web-ui/src',
  ],
) {
  const result = new Set<string>()
  for (const folder of folders) {
    for (const file of await readdir(folder, { recursive: true })) {
      const path = join(folder, file)
      if (!/locale/.test(path) || !/\.tsx?$/.test(file)) continue
      const source = await readFile(path, 'utf8')
      // Include multiline translations too; only namespaced catalog keys are labels.
      for (const match of source.matchAll(/^\s*['"]([\w.-]+)['"]\s*:/gm)) {
        if (match[1]?.includes('.')) result.add(match[1])
      }
    }
  }
  return [...result]
}

/** Serializable browser callback; also tested with a synthetic DOM, independently of product UI. */
export function unresolvedLabels(known: string[]) {
  const keys = new Set(known)
  const namespaces = new Set(known.map((key) => key.split('.')[0]))
  const result: string[] = []
  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (!element.checkVisibility() || element.closest('pre, code, script, style')) continue
    const values = [element.getAttribute('aria-label'), element.getAttribute('placeholder')]
    if (!element.children.length && element.tagName !== 'TEXTAREA') values.push(element.textContent)
    for (const value of values) {
      const text = value?.trim()
      if (
        text &&
        (keys.has(text) ||
          (namespaces.has(text.split('.')[0]) && /^[a-z][\w-]*\.[\w.-]+$/i.test(text)) ||
          /^(?:app|shell|settings|composer|index-shell|cards|session|topbar|sidebar|tool|goal)\.[\w.-]+$/.test(
            text,
          ))
      )
        result.push(text)
    }
    const key = element.dataset.i18n
    if (key && element.textContent?.trim() === key) result.push(key)
  }
  return [...new Set(result)]
}
