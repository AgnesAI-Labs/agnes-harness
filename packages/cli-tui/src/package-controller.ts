import type { PackageOperation, PackagePreview } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import {
  formatPackageOperation,
  formatPreview,
  inspectPackage,
  installPreview,
  newPackageCommandId,
  parsePackageSource,
  waitForPackageOperation,
} from './package-admin.js'

type PendingInstall = Readonly<{ preview: PackagePreview }>

/**
 * Local TUI state for package preview/confirmation. It sits entirely outside Session and never
 * creates a user row or queued prompt; the daemon remains the sole package-operation authority.
 */
export class PackageController {
  private pending: PendingInstall | undefined

  constructor(
    private readonly client: NodeClient | undefined,
    private readonly profile: () => string,
  ) {}

  async packages(): Promise<string> {
    if (!this.client) return 'Package management is unavailable on this connection.'
    const result = await this.client.packages.list({ profile: this.profile() })
    return result.packages.length === 0
      ? 'No packages installed.'
      : result.packages
          .map(
            (item) =>
              `${item.id}@${item.version} desired=${item.desired} actual=${item.actual} trusted=${item.trusted}`,
          )
          .join('\n')
  }

  async install(argument: string | undefined): Promise<string> {
    if (!this.client) return 'Package management is unavailable on this connection.'
    if (argument === 'cancel') {
      this.pending = undefined
      return 'Installation cancelled.'
    }
    if (argument === 'confirm') return this.confirm()
    if (!argument) return this.pending ? 'usage: /install confirm | cancel' : 'usage: /install <source>'
    this.pending = undefined
    const preview = await inspectPackage(this.client, this.profile(), parsePackageSource(argument))
    if (preview.blockers.length > 0) return `${formatPreview(preview)}\nInstallation blocked.`
    this.pending = { preview }
    return `${formatPreview(preview)}\nType /install confirm to install, or /install cancel to dismiss.`
  }

  /**
   * Package administration deliberately uses the same receipt-then-poll contract as the Web
   * console and the non-interactive CLI. No worker or package-store details cross this boundary.
   */
  async manage(args: readonly string[]): Promise<string> {
    const client = this.client
    if (!client) return 'Package management is unavailable on this connection.'
    const [action = 'status', ...rest] = args
    const profile = this.profile()
    const require = (index: number, usage: string): string => {
      const value = rest[index]
      if (!value) throw new Error(`usage: ${usage}`)
      return value
    }
    const operation = async (
      kind: 'trust' | 'enable' | 'disable' | 'update' | 'rollback' | 'remove',
      params: Record<string, unknown>,
    ): Promise<string> => {
      const receipt = await client.packages[kind]({
        profile,
        clientId: await client.clientId(),
        commandId: newPackageCommandId(kind),
        ...params,
      } as never)
      return formatPackageOperation(await waitForPackageOperation(client, receipt))
    }

    switch (action) {
      case 'status':
      case 'list':
        if (rest.length) throw new Error('usage: /package [status|list]')
        return this.packages()
      case 'catalog': {
        if (rest.length > 1) throw new Error('usage: /package catalog [query]')
        const page = await client.packages.catalog.list({
          profile,
          ...(rest[0] ? { query: rest[0] } : {}),
        })
        return page.items.length === 0
          ? 'No catalog packages found.'
          : page.items.map((item) => `${item.id}@${item.version}`).join('\n')
      }
      case 'inspect': {
        if (rest.length !== 1) throw new Error('usage: /package inspect <source>')
        return formatPreview(await inspectPackage(client, profile, parsePackageSource(require(0, ''))))
      }
      case 'trust':
        if (rest.length !== 3) throw new Error('usage: /package trust <id> <integrity> <capabilityHash>')
        return operation('trust', {
          id: require(0, ''),
          expectedIntegrity: require(1, ''),
          capabilityHash: require(2, ''),
        })
      case 'enable':
      case 'disable':
      case 'rollback':
      case 'remove':
        if (rest.length !== 1) throw new Error(`usage: /package ${action} <id>`)
        return operation(action, { id: require(0, '') })
      case 'update':
        if (rest.length !== 3) throw new Error('usage: /package update <id> <source> <integrity>')
        return operation('update', {
          id: require(0, ''),
          source: parsePackageSource(require(1, '')),
          expectedIntegrity: require(2, ''),
        })
      case 'operation': {
        if (rest.length !== 1) throw new Error('usage: /package operation <operationId>')
        const result: PackageOperation = await client.packages.operation.get({
          profile,
          operationId: require(0, ''),
        })
        return formatPackageOperation(result)
      }
      case 'cancel': {
        if (rest.length !== 1) throw new Error('usage: /package cancel <operationId>')
        const receipt = await client.packages.operation.cancel({
          profile,
          operationId: require(0, ''),
          clientId: await client.clientId(),
          commandId: newPackageCommandId('cancel'),
        })
        return `cancel accepted ${receipt.operationId}`
      }
      default:
        throw new Error(`unknown package action ${action}; use /help`)
    }
  }

  private async confirm(): Promise<string> {
    if (!this.client) return 'Package management is unavailable on this connection.'
    const pending = this.pending
    if (!pending) return 'No installation is awaiting confirmation.'
    this.pending = undefined
    const operation = await installPreview(this.client, this.profile(), pending.preview)
    const installed = operation.installed
    return installed
      ? `Installed ${installed.id}@${installed.version}; disabled and untrusted.`
      : `Installation ${operation.state}.`
  }
}
