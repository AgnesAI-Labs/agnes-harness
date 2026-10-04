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

  get comparison(): boolean {
    return this.selected === 'comparison'
  }

  /** Draft UI choices; comparison is not a runtime registered with the backend. */
  get options(): Pick<RuntimeDescriptor, 'id' | 'label' | 'available' | 'unavailableReason'>[] {
    return [
      ...this.items,
      {
        id: 'comparison',
        label: '双线对比 · Native + JevLoop',
        available: ['native', 'jevloop'].every((id) =>
          this.items.some((item) => item.id === id && item.available),
        ),
        unavailableReason: '需要 Native 与 JevLoop 均可用',
      },
    ]
  }

  get available(): boolean {
    return this.options.some((item) => item.id === this.selected && item.available)
  }

  creation(): { runtime?: string } {
    if (!this.available) throw new Error('所选运行循环不可用，请刷新运行循环列表。')
    if (this.comparison) throw new Error('双线对比必须通过对比创建接口。')
    return this.legacy ? {} : { runtime: this.selected }
  }

  label(identity?: RuntimeIdentity): string {
    if (!identity) return this.options.find((item) => item.id === this.selected)?.label ?? this.selected
    return `${this.items.find((item) => item.id === identity.id)?.label ?? identity.id} · v${identity.version}`
  }
}
