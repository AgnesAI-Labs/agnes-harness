import { remoteFrontendOrigin, rpcError } from '@agnes/protocol'

async function connectionBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw Error('missing connection response')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 16_384) throw Error('connection response too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Platform credentials stay on A's trusted daemon/launcher leg, for this exact sandbox. */
export async function cloudSandboxConnection(
  origin: string | undefined,
  key: string,
  fetcher: typeof fetch,
): Promise<{ origin: string; trafficToken: string } | undefined> {
  const target = origin ? new URL(origin) : undefined
  // Ordinary IP/domain connections keep their existing direct transport.
  if (!key.startsWith('agh_sk_')) {
    if (!origin) throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_REJECTED' })
    return
  }
  if (target && !/^8443-[a-z0-9-]+\.[a-z0-9-]+\.tencentags\.com$/u.test(target.hostname)) return
  if (target && (target.protocol !== 'https:' || target.port || (origin?.length ?? 0) > 512))
    throw rpcError('SEMANTIC_REJECTED', { reason: 'CLOUD_CONNECTION_INVALID' })
  const configured = process.env.AGH_LLMSG_API_BASE_URL
  if (!configured) throw rpcError('SEMANTIC_REJECTED', { reason: 'CLOUD_BROKER_REQUIRED' })
  const base = remoteFrontendOrigin(configured)
  const broker = new URL(base)
  if (broker.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(broker.hostname))
    throw Error('sandbox credential service requires HTTPS')
  const response = await fetcher(`${base}/llmsg/api/agh/connection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(origin ? { sandbox_url: origin } : {}),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const reason =
      response.status === 401 || response.status === 403
        ? 'CONFIG_CREDENTIAL_REJECTED'
        : response.status === 400
          ? 'CLOUD_CONNECTION_INVALID'
          : response.status === 409
            ? 'CLOUD_SANDBOX_NOT_READY'
            : response.status === 429
              ? 'CLOUD_RATE_LIMITED'
              : 'CONFIG_AUTH_UNAVAILABLE'
    throw rpcError('SEMANTIC_REJECTED', { reason })
  }
  const body = (await connectionBody(response)) as {
    code?: unknown
    data?: { sandbox_url?: unknown; traffic_token?: unknown }
  } | null
  const token = body?.data?.traffic_token
  const address = body?.data?.sandbox_url
  if (
    body?.code !== 200 ||
    typeof address !== 'string' ||
    address.length > 512 ||
    (origin !== undefined && address !== origin) ||
    typeof token !== 'string' ||
    !token ||
    token.length > 8192 ||
    /[^\x21-\x7e]/u.test(token)
  )
    throw Error('invalid sandbox credential')
  const resolved = new URL(remoteFrontendOrigin(address))
  if (
    resolved.origin !== address ||
    resolved.protocol !== 'https:' ||
    resolved.port ||
    !/^8443-[a-z0-9-]+\.[a-z0-9-]+\.tencentags\.com$/u.test(resolved.hostname)
  )
    throw Error('invalid sandbox target')
  return { origin: resolved.origin, trafficToken: token }
}
