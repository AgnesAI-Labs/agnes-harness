// Adapted from dsh-superagent (MIT)
/**
 * Each role's model: Superagent's settings name a provider, model and reasoning effort; on AGH they are a configured
 * route, its model and a thinking level. A role's model is selected when its session is created and again when the
 * setting changes; AGH's own default stays as it is.
 */
import type { Store } from '../app/store.js'
import type { RoleModel } from '../policy.js'
import type { SessionClient, SessionHandle, SessionRegistry, SessionRole } from './sessions.js'

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type Thinking = (typeof THINKING)[number]
export interface AghModel {
  slot: 'primary'
  route: string
  model: string
  thinking?: Thinking
}
type Role = 'orchestrator' | 'worker'

/**
 * Resolves a role model against the routes AGH has configured: the route must exist and be enabled; its model list is no
 * restriction, as a provider may serve more models than it lists.
 */
export async function resolveRoleModel(
  client: Pick<SessionClient, 'config'>,
  model: RoleModel,
): Promise<AghModel> {
  const accounts = (await client.config.get()).accounts ?? []
  if (!accounts.some((account) => account.route === model.provider && account.enabled))
    throw new Error(`AGH has no enabled model route ${model.provider}`)
  const effort = model.reasoningEffort
  if (effort !== undefined && !(THINKING as readonly string[]).includes(effort))
    throw new Error(`The reasoning effort ${effort} is not one of ${THINKING.join(', ')}`)
  return {
    slot: 'primary',
    route: model.provider,
    model: model.model,
    ...(effort !== undefined ? { thinking: effort as Thinking } : {}),
  }
}

/** The models AGH has configured, by route, in the shape the panel and `orchestrator_read models` show. */
export async function modelCatalog(client: Pick<SessionClient, 'config'>) {
  const accounts = ((await client.config.get()).accounts ?? []).filter((account) => account.enabled)
  const first = accounts[0]
  return {
    default: first ? { route: first.route, model: first.model } : null,
    groups: accounts.map((account) => ({
      id: account.route,
      name: account.label,
      models: account.models.map((item) => ({ id: item.id, name: item.name })),
    })),
    failures: [] as string[],
  }
}

/** Selects role models on Superagent's sessions and keeps them in step with the settings. */
export class RoleModels {
  /** The selection last applied to each session, so an unchanged setting is not applied again. */
  private readonly applied = new Map<string, string>()
  private sessions?: { handle(id: string): Promise<SessionHandle> }
  private registry?: Pick<SessionRegistry, 'ids' | 'role'>
  constructor(
    private readonly deps: { client: Pick<SessionClient, 'config'>; store: Pick<Store, 'settings'> },
  ) {}
  bind(
    sessions: { handle(id: string): Promise<SessionHandle> },
    registry: Pick<SessionRegistry, 'ids' | 'role'>,
  ) {
    this.sessions = sessions
    this.registry = registry
  }
  private configured(role: Role): RoleModel | null {
    const settings = this.deps.store.settings()
    return role === 'orchestrator' ? settings.eval.model : settings.executor.model
  }
  /** Selects the role's configured model on a session; a role without one keeps AGH's default. */
  async apply(role: Role, session: SessionHandle): Promise<void> {
    const model = this.configured(role)
    const wanted = JSON.stringify(model)
    if (!model || this.applied.get(session.id) === wanted) return
    await session.setModel(await resolveRoleModel(this.deps.client, model))
    this.applied.set(session.id, wanted)
  }
  /** Applies changed role models to the open sessions of each role; one session that fails leaves the others. */
  async sync(): Promise<void> {
    const { sessions, registry } = this
    if (!sessions || !registry) return
    const failures: unknown[] = []
    for (const id of registry.ids()) {
      const role: SessionRole | undefined = registry.role(id)
      if (!role) continue
      await sessions
        .handle(id)
        .then((session) => this.apply(role.kind, session))
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length) throw new AggregateError(failures, 'Selecting role models failed')
  }
}
