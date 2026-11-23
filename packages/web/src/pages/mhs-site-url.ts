export const DEFAULT_MHS_SITE_URL = 'https://agh.agnes-ai.cn'

function runtimeMhsSiteUrl(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const raw = document.querySelector<HTMLMetaElement>('meta#agnes-config')?.dataset.mhsSite?.trim()
  if (!raw || raw === '__AGNES_MHS_SITE_URL__') return undefined
  return raw
}

/** Resolve the MHS external site URL for the active UI locale. */
export function resolveMhsSiteUrl(locale: string, configured?: string): string {
  const raw = configured?.trim() || runtimeMhsSiteUrl() || DEFAULT_MHS_SITE_URL
  const base = raw.replace(/\/+$/, '')
  return locale === 'zh-CN' ? `${base}/` : `${base}/en/`
}
