import { type Context, Service } from '@agnes/cordis'
import type { ClientCommand, CommandAuthorizer } from './service-contracts.js'

export class CommandService extends Service {
  private readonly entries = new Map<string, Readonly<{ owner: string; command: ClientCommand }>>()

  constructor(
    ctx: Context,
    private readonly authorize: CommandAuthorizer = async () => false,
  ) {
    super(ctx, 'commands')
  }

  register(owner: string, command: ClientCommand): () => void {
    if (typeof command.id !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(command.id))
      throw new TypeError('client command id must be a stable lowercase identifier')
    if (typeof command.execute !== 'function')
      throw new TypeError('client command execute must be a function')
    const current = this.entries.get(command.id)
    if (current) throw new Error(`client command already registered: ${command.id}`)
    const entry = Object.freeze({ owner, command: Object.freeze({ ...command }) })
    this.entries.set(command.id, entry)
    return () => {
      if (this.entries.get(command.id) === entry) this.entries.delete(command.id)
    }
  }

  list(): readonly Readonly<{ id: string; title?: string; owner: string }>[] {
    return [...this.entries.values()]
      .map(({ owner, command }) => ({
        owner,
        id: command.id,
        ...(command.title ? { title: command.title } : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async execute(id: string, input: unknown): Promise<unknown> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`client command is not registered: ${id}`)
    if (!(await this.authorize({ owner: entry.owner, command: entry.command, input })))
      throw new Error(`client command is not authorized: ${id}`)
    return await entry.command.execute(input)
  }

  async executeOwned(owner: string, id: string, input: unknown): Promise<unknown> {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) throw new Error(`client command is not registered: ${id}`)
    return await this.execute(id, input)
  }
}

/** 宿主绑定的当前模块身份；是版本提示，不是安全凭据（WC6）。 */
