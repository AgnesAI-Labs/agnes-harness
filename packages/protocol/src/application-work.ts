import type { ApplicationWorkObject } from '../gen/ts/extension-manifest.js'

export type ApplicationWorkRequest = Readonly<{
  applicationId: string
  packageId: string
  actionId: string
  object?: ApplicationWorkObject
}>

/** Decode only the bounded explicit work envelope; ordinary user JSON stays ordinary text.
 * The persisted suffix is unchanged. This is presentation context, never authorization. */
export function applicationWorkText(text: string): { text: string; request?: ApplicationWorkRequest } {
  const start = text.lastIndexOf('\n\n{')
  const suffix = (start >= 0 ? text.slice(start + 2) : text).trim()
  if (!suffix.startsWith('{') || suffix.length > 8192) return { text }
  try {
    const value = JSON.parse(suffix)
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.applicationId !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.applicationId) ||
      typeof value.packageId !== 'string' ||
      !value.packageId ||
      value.packageId.length > 512 ||
      typeof value.actionId !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(value.actionId) ||
      Object.keys(value).some((key) => !['applicationId', 'packageId', 'actionId', 'object'].includes(key)) ||
      (value.object !== undefined &&
        (!value.object ||
          typeof value.object.type !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9.-]{0,63}$/.test(value.object.type) ||
          typeof value.object.id !== 'string' ||
          !value.object.id ||
          value.object.id.length > 128 ||
          Object.keys(value.object).some((key) => !['type', 'id'].includes(key))))
    )
      return { text }
    return { text: start >= 0 ? text.slice(0, start) : '', request: value }
  } catch {
    return { text }
  }
}
