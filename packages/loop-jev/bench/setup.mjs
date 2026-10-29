// Bench setup: which routes the host will serve, the self-contained fake home, the probe
// interpreter and the headless bundle. Nothing here starts a host or a session.
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { buildBundle } from './lib.mjs'

/** A refusal the operator can fix: printed without a stack, exit code 2. */
export class SetupError extends Error {}

export const DEFAULT_PROFILE = 'local-dev'
/** The built-in profile templates; the host layers a profile over the template of the same name. */
export const PROFILES = ['local-dev', 'enterprise']

/**
 * The nearest directory at or above `path` that holds `.git`, if any. A session workspace inside a
 * repository picks up that repository's instruction files and exposes it to the agent's tools.
 */
export function gitAncestor(path) {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}
const JEV_API = 'typesafe-systemone'
const JEV_MODEL_ID = 'typesafe/jev-1.13-20260917'
/** A placeholder: the loopback stand-in accepts any bearer key. */
const FAKE_KEY = 'TEST-KEY-0123456789'

// ---- routes -------------------------------------------------------------------------------

const names = (routes) =>
  routes
    .map((r) => r.route)
    .sort()
    .join(', ')

function pickRoute({ routes, wanted, flag, kind, where, missing }) {
  if (wanted !== undefined) {
    const found = routes.all.find((r) => r.route === wanted)
    if (!found)
      throw new SetupError(`route ${wanted} (${flag}) is not in ${where}; routes: ${names(routes.all)}`)
    if (!routes.pool.includes(found)) throw new SetupError(`route ${wanted} is not a ${kind} route (${flag})`)
    return found
  }
  if (routes.pool.length === 0) throw new SetupError(`${missing} in ${where}`)
  if (routes.pool.length > 1)
    throw new SetupError(`several ${kind} routes in ${where} (${names(routes.pool)}); pass ${flag} <route>`)
  return routes.pool[0]
}

function pickModel(route, wanted, flag) {
  const models = route.models ?? []
  if (wanted === undefined) {
    // The account's selected model comes first in the routes Settings renders.
    if (models[0]) return models[0]
    throw new SetupError(`route ${route.route} declares no model`)
  }
  const found = models.find((m) => m.id === wanted)
  if (!found)
    throw new SetupError(
      `model ${wanted} (${flag}) is not on route ${route.route}; models: ${models.map((m) => m.id).join(', ')}`,
    )
  return found
}

/**
 * The routes the host will serve for this home, read the way the host reads them at boot: the
 * accounts saved in Settings (configuration service) over the profile file. Settings replaces the
 * profile file's whole `provider` block as soon as it holds an account, so a home has one source.
 */
export async function discoverRoutes(o) {
  const { createConfigurationService, readConfigurationProfileInputs } = await import('@agnes/host')
  let configuration
  try {
    configuration = await createConfigurationService({ home: o.home, profile: o.profile }).profileInput()
  } catch (error) {
    const code = error?.code ?? (error instanceof Error ? error.message : String(error))
    throw new SetupError(
      `the accounts saved in Settings for ${o.home} cannot be read (${code}); open Settings and check that every enabled account has its key`,
    )
  }
  const inputs = await readConfigurationProfileInputs({
    home: o.home,
    workspaceRoot: o.cwd,
    profile: o.profile,
    agnesVersion: o.agnesVersion,
    configuration,
  })
  const source = configuration.provider ? 'settings' : 'profile'
  const where =
    source === 'settings'
      ? `the accounts saved in Settings for ${o.home}`
      : `${join(o.home, 'profiles', o.profile, 'profile.yaml')} (Settings holds no account)`
  const all = inputs.user?.provider?.routes ?? []
  const jevPool = all.filter((r) => r.api === JEV_API)
  // The baseline lanes never call Jev, so a home without a Jev account can still run them.
  const skipJev = !o.needJev && o.jevRoute === undefined && jevPool.length !== 1
  const jevRoute = skipJev
    ? undefined
    : pickRoute({
        routes: { all, pool: jevPool },
        wanted: o.jevRoute,
        flag: '--jev-route',
        kind: 'Jev side-model',
        where,
        missing: 'no Jev side-model account (Settings > Side models, a TypeSafe Jev entry)',
      })
  const chatRoute = pickRoute({
    routes: { all, pool: all.filter((r) => r.api !== JEV_API) },
    wanted: o.chatRoute,
    flag: '--chat-route',
    kind: 'chat model',
    where,
    missing: 'no chat model account (Settings > Models & accounts)',
  })
  const jevModel = jevRoute && pickModel(jevRoute, o.jevModel, '--jev-model')
  const chatModel = pickModel(chatRoute, o.chatModel, '--chat-model')
  const prices = new Map()
  for (const route of all)
    for (const model of route.models ?? [])
      if (model.cost) prices.set(`${route.route}/${model.id}`, model.cost)
  return {
    source,
    jev: jevRoute ? { route: jevRoute.route, model: jevModel.id } : null,
    chat: { route: chatRoute.route, model: chatModel.id },
    prices,
  }
}

// ---- the self-contained fake home ---------------------------------------------------------

const modelRecord = (over) => ({
  name: over.id,
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  ...over,
})

/** The scripted adapter accepts a reply only with exactly one usage event. */
const SCRIPTED_REPLY = [
  { type: 'text_delta', delta: 'ok' },
  {
    type: 'usage',
    tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    creditSource: 'estimated',
  },
  { type: 'done', reason: 'stop' },
]

/**
 * A home that needs no account and no network: a loopback stand-in for Jev and the built-in
 * scripted adapter as the chat model, both declared in the profile file with a file secret store
 * holding a placeholder key. Only for checking the plumbing; it says nothing about either loop.
 */
export async function prepareFakeHome(out) {
  const { startFakeSystemOne } = await import('@agnes/ai/testkit')
  const { createCredentialStore, initializeHomeLocked } = await import('@agnes/host')
  const home = join(out, 'home')
  await initializeHomeLocked(home, DEFAULT_PROFILE)
  const store = join(home, 'secrets')
  await createCredentialStore({ root: home }).putApiKey('secret://jev/key', FAKE_KEY)
  const fake = await startFakeSystemOne()
  const routes = [
    {
      route: 'jev',
      api: JEV_API,
      baseUrl: fake.url,
      credentialRef: 'secret://jev/key',
      models: [
        modelRecord({
          id: JEV_MODEL_ID,
          api: JEV_API,
          route: 'jev',
          baseUrl: fake.url,
          cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 65536,
          maxTokens: 32768,
          toolCallFormats: [],
          thinkingReplay: 'drop',
        }),
      ],
    },
    {
      route: 'main',
      api: 'scripted',
      baseUrl: 'https://scripted.invalid',
      compat: { replies: [SCRIPTED_REPLY], repeatLast: true },
      models: [
        modelRecord({
          id: 'main-1',
          api: 'scripted',
          route: 'main',
          baseUrl: 'https://scripted.invalid',
          cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
        }),
      ],
    },
  ]
  const profileDir = join(home, 'profiles', DEFAULT_PROFILE)
  // JSON is valid YAML 1.2, so the profile file needs no YAML writer.
  const profile = {
    name: DEFAULT_PROFILE,
    adapters: { secrets: { kind: 'file', path: store } },
    provider: { package: '@agnes/ai', routes },
  }
  try {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(profileDir, 'profile.yaml'), `${JSON.stringify(profile, null, 2)}\n`)
  } catch (error) {
    await fake.close()
    throw error
  }
  return { home, profile: DEFAULT_PROFILE, close: () => fake.close() }
}

// ---- the probe interpreter ----------------------------------------------------------------

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function onPath(name, env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}

function locate(value, env) {
  if (isAbsolute(value) || value.includes('/')) return executable(value) ? value : undefined
  return onPath(value, env)
}

/**
 * The interpreter the probes' `python` runs: `--python`, then BENCH_PYTHON, then python3, then
 * python on PATH. A value given explicitly must work; it never falls back to something else.
 */
export function resolvePython({ flag, env }) {
  for (const [value, from] of [
    [flag, '--python'],
    [env.BENCH_PYTHON, 'BENCH_PYTHON'],
  ]) {
    if (value === undefined || value === '') continue
    const found = locate(value, env)
    if (!found)
      throw new SetupError(`the Python interpreter given by ${from} (${value}) is not an executable file`)
    return { path: found, from }
  }
  for (const name of ['python3', 'python']) {
    const found = onPath(name, env)
    if (found) return { path: found, from: `PATH (${name})` }
  }
  return undefined
}

const PYTHON_WORD = /(^|[\s;&|(`$])python3?(?=\s|$)/m

export const probesNeedPython = (suite) =>
  suite.scenarios.some((s) => s.turns.some((t) => (t.bash ?? []).some((p) => PYTHON_WORD.test(p.command))))

/** Writes a `python` that runs the resolved interpreter, for prepending to the probes' PATH. */
export function writePythonShim(dir, interpreter) {
  mkdirSync(dir, { recursive: true })
  const quoted = `'${interpreter.replaceAll("'", `'\\''`)}'`
  writeFileSync(join(dir, 'python'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 })
  return dir
}

// ---- the bundle ---------------------------------------------------------------------------

/** The headless bundle: the plugin row with the discovered Jev route, the tool set, one preset per cell. */
export function benchBundle({ suite, lanes, reps, stepCap, basePreset, jev }) {
  const bundle = buildBundle({ suite, lanes, reps, stepCap, basePreset })
  const row = bundle.profile.plugins['ext:agnes.jev/loop']
  if (jev) row.config = { ...row.config, jev: { route: jev.route, model: jev.model } }
  return bundle
}
