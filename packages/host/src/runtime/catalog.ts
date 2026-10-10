import type { SessionImpl, SessionLoop } from '@agnes/core'
import {
  NATIVE_RUNTIME,
  RuntimeError,
  type RuntimeIdentity,
  RuntimeRegistry,
  readRuntimeIdentity,
} from '@agnes/runtime-api'
import { decisionBackendStatus } from './jev-decision-pool.js'
import { JEV_IDENTITY, type JevLoopOptions, openJevLoop } from './jev-loop.js'
import { createJevDecisionTransport } from './jev-transport.js'

export interface RuntimeOpenContext {
  open(factory?: (session: SessionImpl) => Promise<SessionLoop>): Promise<SessionImpl>
  /** Exact new writer retained after an initialization drain failed, never a cached other owner. */
  failedSession?(): SessionImpl | undefined
}
export type SessionRuntimeRegistry = RuntimeRegistry<RuntimeOpenContext, SessionImpl>

export type JevEnvironmentConfiguration =
  | JevLoopOptions
  | { readonly unavailableReason: string; readonly backend?: 'jev' | 'laya' }

/** The only composition root importing both implementations. No plugin discovery is implied. */
export function createSessionRuntimeRegistry(
  configuration?: JevEnvironmentConfiguration,
): SessionRuntimeRegistry {
  const jev = configuration && 'decision' in configuration ? configuration : undefined
  const unavailableReason =
    configuration && 'unavailableReason' in configuration
      ? configuration.unavailableReason
      : 'Jev 决策服务未配置，请在设置中配置并重启后台。'
  const registry = new RuntimeRegistry<RuntimeOpenContext, SessionImpl>()
  registry.register({
    descriptor: {
      ...NATIVE_RUNTIME,
      apiVersion: 1,
      label: 'Native',
      available: true,
      capabilities: { prompt: true, cancel: true, resume: true, compact: true, fork: true },
    },
    open: (context) => context.open(),
  })
  registry.register({
    descriptor: {
      ...JEV_IDENTITY,
      apiVersion: 1,
      label: 'JevLoop',
      available: !!jev,
      ...(jev
        ? {
            defaultDecisionBackend: jev.defaultDecisionBackend ?? jev.decision.backend,
            decisionBackends: decisionBackendStatus(jev),
          }
        : {}),
      ...(!jev ? { unavailableReason } : {}),
      capabilities: { prompt: true, cancel: true, resume: true, compact: false, fork: false },
    },
    open(context) {
      if (!jev) throw new RuntimeError('E_RUNTIME_UNAVAILABLE', 'Jev decision backend is unavailable')
      return context.open((session) => openJevLoop(session, jev))
    },
  })
  return registry
}

export function selectSessionRuntime(
  registry: SessionRuntimeRegistry,
  persisted: unknown,
  requested?: string,
): RuntimeIdentity {
  const owner = persisted === undefined ? undefined : readRuntimeIdentity(persisted)
  if (requested !== undefined && owner && requested !== owner.id)
    throw new RuntimeError('E_RUNTIME_OWNER', 'an existing session cannot change its runtime')
  if (owner) return owner
  const id = requested ?? NATIVE_RUNTIME.id
  const descriptor = registry.list().find((item) => item.id === id)
  if (!descriptor) throw new RuntimeError('E_RUNTIME_UNAVAILABLE', `unknown runtime ${id}`)
  return { id: descriptor.id, version: descriptor.version }
}

export async function openRuntimeSession(
  registry: SessionRuntimeRegistry,
  owner: RuntimeIdentity,
  context: RuntimeOpenContext,
): Promise<SessionImpl> {
  const lease = registry.acquire(owner)
  let session: SessionImpl
  try {
    session = await lease.open(context)
  } catch (error) {
    const failed = context.failedSession?.()
    if (
      failed &&
      failed.runtimeIdentity.id === owner.id &&
      failed.runtimeIdentity.version === owner.version
    ) {
      const close = failed.close.bind(failed)
      failed.close = async () => {
        await close()
        lease.release()
      }
    } else lease.release()
    throw error
  }
  const close = session.close.bind(session)
  session.close = async () => {
    await close()
    lease.release()
  }
  return session
}

/** Configuration failures disable only Jev; Native startup does not depend on remote credentials. */
export function jevFromEnvironment(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): JevEnvironmentConfiguration | undefined {
  const endpoint = env.AGNES_JEV_ENDPOINT?.trim()
  const model = env.AGNES_JEV_MODEL?.trim()
  const backend = env.AGNES_JEV_BACKEND?.trim() || 'jev'
  const configured = [
    'AGNES_JEV_BACKEND',
    'AGNES_JEV_ENDPOINT',
    'AGNES_JEV_MODEL',
    'AGNES_JEV_TRANSPORT',
    'AGNES_JEV_AUTHENTICATION',
    'AGNES_JEV_API_KEY',
    'TYPESAFE_API_KEY',
    'AGNES_JEV_DECISION_REQUEST_CREDITS',
    'AGNES_JEV_LANGUAGE_REQUEST_CREDITS',
  ].some((key) => env[key] !== undefined)
  if (!configured) return undefined
  const unavailable = (unavailableReason: string): JevEnvironmentConfiguration => ({
    unavailableReason,
    ...(backend === 'jev' || backend === 'laya' ? { backend } : {}),
  })
  if (backend !== 'jev' && backend !== 'laya') return unavailable('决策后端无效，请选择 jev 或 laya。')
  if (!endpoint || !model) return unavailable('Jev 环境配置不完整，请同时配置服务地址与模型。')
  const transport = env.AGNES_JEV_TRANSPORT?.trim() || 'native'
  if (backend === 'laya' && transport !== 'native') return unavailable('本地 Laya 仅支持 native 传输。')
  if (transport !== 'native' && transport !== 'cloudflare')
    return unavailable('Jev 传输类型无效，请选择 native 或 cloudflare。')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return unavailable('Jev 决策服务地址无效，请配置有效的 HTTP 或 HTTPS 地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return unavailable('Jev 决策服务地址须为不含凭据、查询参数或片段的 HTTP 或 HTTPS 地址。')
  if (
    transport === 'native' &&
    url.hostname === 'api.cloudflare.com' &&
    /^\/client\/v4\/accounts\/[^/]+\/ai\/run$/.test(url.pathname)
  )
    return unavailable('Cloudflare 地址必须使用 cloudflare 传输类型，请检查 AGNES_JEV_TRANSPORT。')
  const authentication = env.AGNES_JEV_AUTHENTICATION?.trim() || 'bearer'
  if (authentication !== 'bearer' && authentication !== 'none')
    return unavailable('Jev 认证方式无效，请将 AGNES_JEV_AUTHENTICATION 设为 bearer 或 none。')
  if (transport === 'cloudflare' && authentication !== 'bearer')
    return unavailable('Cloudflare Jev 必须使用 Bearer 认证。')
  const configuredToken =
    env.AGNES_JEV_API_KEY?.trim() || (backend === 'jev' ? env.TYPESAFE_API_KEY?.trim() : undefined)
  if (authentication === 'bearer' && !configuredToken)
    return unavailable(
      backend === 'laya'
        ? 'Laya 缺少 Bearer 密钥，请配置 AGNES_JEV_API_KEY；仅匿名服务可显式设置 AGNES_JEV_AUTHENTICATION=none。'
        : 'Jev 缺少 Bearer 密钥，请配置 AGNES_JEV_API_KEY 或 TYPESAFE_API_KEY；仅匿名服务可显式设置 AGNES_JEV_AUTHENTICATION=none。',
    )
  if (authentication === 'bearer' && /[\r\n]/.test(configuredToken ?? ''))
    return unavailable('Jev Bearer 密钥格式无效。')
  const bounds: Record<string, number | undefined> = {}
  for (const name of ['AGNES_JEV_DECISION_REQUEST_CREDITS', 'AGNES_JEV_LANGUAGE_REQUEST_CREDITS']) {
    if (env[name] === undefined) continue
    const value = Number(env[name])
    if (!Number.isFinite(value) || value <= 0) return unavailable(`${name} 必须为有限正数。`)
    bounds[name] = value
  }
  const decisionCredits = bounds.AGNES_JEV_DECISION_REQUEST_CREDITS
  const languageCredits = bounds.AGNES_JEV_LANGUAGE_REQUEST_CREDITS
  return {
    requestCredits: {
      ...(decisionCredits === undefined ? {} : { decision: decisionCredits }),
      ...(languageCredits === undefined ? {} : { language: languageCredits }),
    },
    decision: {
      backend,
      endpoint,
      model,
      transport: createJevDecisionTransport({
        backend,
        endpoint,
        transport,
        fetcher,
        ...(authentication === 'bearer' && configuredToken ? { token: configuredToken } : {}),
      }),
    },
  }
}
