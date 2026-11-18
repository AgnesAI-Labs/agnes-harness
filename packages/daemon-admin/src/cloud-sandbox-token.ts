import { remoteFrontendOrigin, rpcError } from '@agnes/protocol'

/** Platform credentials are resolved only in the local daemon, for the explicitly selected sandbox. */
export async function cloudSandboxToken(
  origin: string,
  key: string,
  fetcher: typeof fetch,
): Promise<string | undefined> {
  const target = new URL(origin)
  // Other deployments may use Tencent with their own authentication; only LLMSG keys opt in.
  if (!key.startsWith('agh_sk_')) return
  if (!/^8443-[a-z0-9-]+\.[a-z0-9-]+\.tencentags\.com$/u.test(target.hostname)) return
  if (target.protocol !== 'https:' || target.port) throw new Error('invalid sandbox origin')
  const base = remoteFrontendOrigin(process.env.AGH_LLMSG_API_BASE_URL ?? 'https://api.llm.sg')
  const broker = new URL(base)
  if (broker.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(broker.hostname))
    throw new Error('sandbox credential service requires HTTPS')
  const response = await fetcher(`${base}/llmsg/api/agh/connection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ sandbox_url: origin }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  if (response.status === 401 || response.status === 403)
    throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_REJECTED' })
  if (!response.ok) throw new Error('sandbox credential unavailable')
  const body = (await response.json()) as {
    code?: unknown
    data?: { sandbox_url?: unknown; traffic_token?: unknown }
  }
  const token = body.data?.traffic_token
  if (
    body.code !== 200 ||
    body.data?.sandbox_url !== origin ||
    typeof token !== 'string' ||
    !token ||
    token.length > 8192 ||
    /[\r\n]/u.test(token)
  )
    throw new Error('invalid sandbox credential')
  return token
}
