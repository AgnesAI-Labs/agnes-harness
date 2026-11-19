import fileTypes from './file-types.json'

const dnsName = /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:[a-z]{2,}|xn--[a-z\d-]+)\.?$/i
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

function parseAddress(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** Address-bar shorthand only. The backend still authorizes each URL or file. */
export function browserAddress(raw: string): string | undefined {
  const value = raw.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return
  if (/^[a-z]:[\\/]/i.test(value)) return value

  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^:/?#]+:\d+(?:[/?#]|$)/.test(value)) {
    const url = parseAddress(value)
    if (url?.protocol === 'file:') return value
    if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password)
      return url.href
    return
  }

  // Relative paths with a supported file suffix keep their existing meaning.
  const authority = value.split(/[/?#]/, 1)[0] ?? ''
  const host = /^(\[[\da-f:.]+\]|[a-z\d.-]+)(?::\d+)?$/i.exec(authority)?.[1]?.toLowerCase()
  if (host && !value.includes('\\')) {
    const loopback = host === 'localhost' || host === '[::1]' || (ipv4.test(host) && host.startsWith('127.'))
    const suffix = host.split('.').at(-1) ?? ''
    const file =
      authority.toLowerCase() === host && !host.startsWith('www.') && Object.hasOwn(fileTypes, suffix)
    if (loopback || ipv4.test(host) || host.startsWith('[') || (!file && dnsName.test(host)))
      return parseAddress(`${loopback ? 'http' : 'https'}://${value}`)?.href
  }
  return /^(?:www\.|[a-z][a-z\d+.-]*:)/i.test(value) ? undefined : value
}
