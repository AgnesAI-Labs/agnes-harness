import type { RuntimeDescriptor, RuntimeIdentity } from '@agnes/protocol'
import { type Client, JsonRpcError } from '@agnes/sdk/browser'

const legacyNative: RuntimeDescriptor = {
  id: 'native',
  version: '1',
  label: 'Native',
  apiVersion: 1,
  available: true,
  capabilities: { prompt: true, cancel: true, resume: true, compact: true, fork: true },
}

/** Catalog discovery and draft selection are separate from the immutable loaded identity. */
export class RuntimeSelection {
  items: RuntimeDescriptor[] = []
  selected = 'native'
  private legacy = false
  extensions: () => Pick<RuntimeDescriptor, 'id' | 'label' | 'available' | 'unavailableReason'>[] = () => []

  async refresh(client: Pick<Client, 'runtime'>): Promise<void> {
    try {
      this.items = (await client.runtime.list()).items
      this.legacy = false
    } catch (error) {
      if (!(error instanceof JsonRpcError && error.code === -32601)) throw error
      this.items = [legacyNative]
      this.legacy = true
    }
  }

  select(id: string): void {
    if (!this.options.some((item) => item.id === id && item.available))
      throw new Error('所选运行方式不可用。')
    this.selected = id
  }

  /** Extra execution destinations are registered by client modules. */
  get options(): Pick<RuntimeDescriptor, 'id' | 'label' | 'available' | 'unavailableReason'>[] {
    return [...this.items, ...this.extensions()]
  }

  get available(): boolean {
    return this.options.some((item) => item.id === this.selected && item.available)
  }

  creation(): { runtime?: string } {
    if (!this.available) throw new Error('所选运行循环不可用，请刷新运行循环列表。')
    if (!this.items.some((item) => item.id === this.selected))
      throw new Error('扩展执行方式必须由其客户端模块处理。')
    return this.legacy ? {} : { runtime: this.selected }
  }

  label(identity?: RuntimeIdentity): string {
    if (!identity) return this.options.find((item) => item.id === this.selected)?.label ?? this.selected
    return `${this.items.find((item) => item.id === identity.id)?.label ?? identity.id} · v${identity.version}`
  }
}
