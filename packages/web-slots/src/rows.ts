/** The daemon-owned row namespace for browser-only package contributions. */
export const WEB_ROW_PREFIX = 'web:'

export function isWebRowId(id: string): boolean {
  return id.startsWith(WEB_ROW_PREFIX) && id.length > WEB_ROW_PREFIX.length
}

export function webRowId(packageId: string): string {
  if (!packageId || packageId.includes(':')) {
    throw new Error(`invalid package id for web row: ${packageId}`)
  }
  return `${WEB_ROW_PREFIX}${packageId}`
}

export function packageIdFromWebRowId(id: string): string | undefined {
  return isWebRowId(id) ? id.slice(WEB_ROW_PREFIX.length) : undefined
}
