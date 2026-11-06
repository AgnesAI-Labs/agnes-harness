/** How a browser sign-in ended, as the last page the browser shows. */
export type OAuthResultPage =
  | 'signed-in'
  | 'cancelled'
  | 'discovery-failed'
  | 'client-id-required'
  | 'state-expired'
  | 'failed'

const TEXT: Readonly<Record<OAuthResultPage, Readonly<{ status: number; en: string; zh: string }>>> = {
  'signed-in': {
    status: 200,
    en: 'AGH sign-in complete. You can close this page.',
    zh: 'AGH 登录完成，可以关掉这个页面。',
  },
  cancelled: {
    status: 400,
    en: 'Sign-in was cancelled. Nothing was saved.',
    zh: '登录已取消，没有保存任何内容。',
  },
  'discovery-failed': {
    status: 502,
    en: "Sign-in failed: the server's OAuth settings could not be read.",
    zh: '登录失败：读不到这个服务的 OAuth 设置。',
  },
  'client-id-required': {
    status: 400,
    en: 'Sign-in needs a client ID for this server. Add one to the server settings, then sign in again.',
    zh: '这个服务登录需要 client ID。请在服务设置里填上，再重新登录。',
  },
  'state-expired': {
    status: 400,
    en: 'This sign-in link has expired or was already used. Start the sign-in again.',
    zh: '这个登录链接已过期或已经用过。请重新开始登录。',
  },
  failed: {
    status: 400,
    en: 'Sign-in failed.',
    zh: '登录失败。',
  },
}

const HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

/**
 * The page a sign-in callback answers with: one sentence in English and Chinese, plus an optional
 * detail (escaped; it may come from the authorization server). No script, no outside resources.
 */
export function renderOAuthResultPage(
  kind: OAuthResultPage,
  detail?: string,
): Readonly<{ status: number; headers: Record<string, string>; body: string }> {
  const text = TEXT[kind]
  const extra = detail ? `<p class="detail">${escapeHtml(detail)}</p>` : ''
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AGH</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}.detail{opacity:.75;word-break:break-word}</style>
</head><body><p>${escapeHtml(text.en)}</p><p lang="zh-CN">${escapeHtml(text.zh)}</p>${extra}</body></html>
`
  return { status: text.status, headers: { ...HEADERS }, body }
}
