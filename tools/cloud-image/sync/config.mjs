import { isAbsolute, join, resolve } from 'node:path'
import { fault, readPrivate, safeRelative, within } from './private-files.mjs'

// LLMSG common.GetUUID() removes hyphens. Preserve the platform's exact identity.
const uuid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u
export function configuration(env = process.env) {
  const tenant = env.AGH_TENANT_ID,
    user = env.AGH_USER_ID,
    state = env.AGH_STATE_ID
  if (!id.test(tenant ?? '') || !id.test(user ?? '') || !uuid.test(state ?? ''))
    throw fault('SYNC_IDENTITY_INVALID')
  const epoch = Number(env.AGH_STATE_EPOCH),
    initialized = env.AGH_STATE_INITIALIZED
  const restore = env.AGH_RESTORE_FROM_EPOCH === '' ? 0 : Number(env.AGH_RESTORE_FROM_EPOCH)
  if (
    !/^[1-9]\d*$/u.test(env.AGH_STATE_EPOCH ?? '') ||
    !Number.isSafeInteger(epoch) ||
    !['true', 'false'].includes(initialized) ||
    !Number.isSafeInteger(restore) ||
    restore < 0 ||
    (initialized === 'true' ? restore < 1 || restore >= epoch : restore !== 0)
  )
    throw fault('SYNC_EPOCH_INVALID')
  const prefix = safeRelative(env.AGH_STATE_PREFIX)
  const paths = [
    env.AGH_HOME ?? '/data/agh',
    env.AGH_ASSETS_DIR ?? '/data/agh-assets',
    env.WORKSPACE_DIR ?? '/workspace/data',
    env.AGH_SYNC_DIR ?? '/run/agh-sync',
  ]
  if (
    paths.some((p) => !isAbsolute(p) || resolve(p) === '/' || resolve(p) !== p) ||
    paths.some((p, i) => paths.some((q, j) => i !== j && within(p, q)))
  )
    throw fault('SYNC_PATH_INVALID')
  const profile = env.AGNES_PROFILE ?? 'local-dev'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(profile)) throw fault('SYNC_PROFILE_INVALID')
  return Object.freeze({
    tenant,
    user,
    state,
    epoch,
    restore,
    initialized: initialized === 'true',
    prefix,
    home: paths[0],
    assets: paths[1],
    workspace: paths[2],
    run: paths[3],
    profile,
    sts: join(paths[3], 'cos-sts.json'),
    socket: join(paths[3], 'control.sock'),
    runtime: env.AGH_RUNTIME_DIR ?? '/opt/agh/runtime',
    litestream: env.AGH_LITESTREAM_BIN ?? '/usr/local/bin/litestream',
  })
}
export function identity(config) {
  return { tenant: config.tenant, user: config.user, state: config.state }
}
export function epochPrefix(config, epoch = config.epoch) {
  return `${config.prefix}/epochs/${epoch}`
}
export async function credentials(config, now = Date.now(), { restoreCompleted = false } = {}) {
  let value
  try {
    value = JSON.parse(await readPrivate(config.sts, 16384))
  } catch (error) {
    if (error.code === 'ENOENT') throw error
    throw fault('SYNC_STS_INVALID')
  }
  if (
    !value ||
    value.prefix !== config.prefix ||
    value.epoch !== config.epoch ||
    (value.restore_from_epoch !== config.restore && !(restoreCompleted && value.restore_from_epoch === 0)) ||
    !Number.isSafeInteger(value.expired_time) ||
    value.expired_time * 1000 <= now + 5000
  )
    throw fault('SYNC_STS_INVALID')
  for (const name of ['tmp_secret_id', 'tmp_secret_key', 'session_token'])
    if (
      typeof value[name] !== 'string' ||
      !value[name] ||
      value[name].length > 8192 ||
      /[^\x21-\x7e]/u.test(value[name])
    )
      throw fault('SYNC_STS_INVALID')
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value.bucket ?? '') ||
    !/^[a-z]{2}-[a-z0-9-]+$/u.test(value.region ?? '')
  )
    throw fault('SYNC_STS_INVALID')
  let endpoint
  try {
    endpoint = new URL(value.endpoint)
  } catch {
    throw fault('SYNC_STS_INVALID')
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    endpoint.port
  )
    throw fault('SYNC_STS_INVALID')
  return { ...value, endpoint: endpoint.origin }
}
export function credentialBinding(value) {
  return JSON.stringify([value.bucket, value.region, value.endpoint, value.prefix, value.epoch])
}
export function publicEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(?:AWS_|LITESTREAM_|COS_|AGH_COS_)/u.test(name)),
  )
}
