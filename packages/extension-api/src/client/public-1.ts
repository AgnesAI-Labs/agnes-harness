// generated from schema/runtime by tools/gen-runtime.ts — do not edit
import type * as Wire from '@agnes/protocol/runtime'
import type { ReactElement } from 'react'
import type { Outcome } from '../runtime/public-api.js'
import type {
  ApprovalClient,
  ArtifactClient,
  DomainView,
  InteractionClient,
  SessionControlClient,
  ShellConversationClient,
  ShellDomainClient,
} from './index.js'

export interface RendererContext {
  readonly clientInstanceId: string
  readonly ownerToken: string
  readonly signal: AbortSignal
  readonly capabilities: Wire.NegotiatedClientCapabilities
  readonly commands: DomainCommandClient
  readonly interactions: InteractionClient
  readonly artifacts: ArtifactClient
  readonly locale: LocaleClient
  onDispose(dispose: () => void | Promise<void>): void
}

export interface WebRendererDefinition<T = Wire.JsonValue> {
  descriptor: Wire.RendererDescriptor
  component(props: { view: DomainView<T>; context: RendererContext }): ReactElement | null
}

export interface LocaleClient {
  readonly locale: string
  text(key: string, parameters?: Readonly<Record<string, string | number>>): string
  formatNumber(value: Wire.LocaleClientFormatNumberRequest): string
  formatDate(value: Wire.Timestamp): string
}

export interface DomainCommandClient {
  submit(request: Wire.DomainCommandClientSubmitRequest): Promise<Outcome<Wire.CommandHandle>>
  commandStatus(requestId: Wire.DomainCommandClientCommandStatusRequest): Promise<Outcome<Wire.CommandHandle>>
}

export interface TextRenderer {
  descriptor: Wire.RendererDescriptor
  format(view: DomainView, context: Readonly<Wire.TextRendererFormatContext>): Outcome<Wire.FormattedView>
}
export interface IMRenderer extends TextRenderer {
  encode(
    formatted: Wire.FormattedView,
    channel: Readonly<Wire.IMRendererEncodeChannel>,
  ): Outcome<Wire.IMRendererEncodeResult>
}
export type SDKFormatter = TextRenderer

export type RendererDefinition = WebRendererDefinition | TextRenderer | IMRenderer

export interface RendererRegistration {
  readonly id: string
  readonly ownerToken: string
  dispose(): Promise<void>
}

export interface UIRegistry {
  register(definition: RendererDefinition): Outcome<RendererRegistration>
  resolve(request: {
    renderKey: string
    viewSchema: Wire.SchemaRef
    target: Wire.ClientCapabilities['target']
    requiredFeatures: string[]
  }): Outcome<
    | {
        kind: 'matched'
        descriptor: Wire.RendererDescriptor
        handle: RendererHandle
      }
    | {
        kind: 'fallback'
        reason: string
      }
  >
}

export interface UIRegistryHost {
  bindRenderer(definition: RendererDefinition): Outcome<RendererHandle>
}

export type UIRegistryFactory = (host: UIRegistryHost) => Outcome<UIRegistry>

export interface RendererHandle {
  readonly id: string
  readonly ownerToken: string
  present(view: DomainView): Outcome<RendererPresentation>
  dispose(): Promise<void>
}

export type RendererPresentation =
  | {
      target: 'web'
      element: ReactElement
    }
  | {
      target: 'tui' | 'sdk'
      formatted: Wire.FormattedView
    }
  | {
      target: 'im'
      formatted: Wire.FormattedView
    }

export interface ClientPresentation {
  domain(view: DomainView): Outcome<RendererPresentation>
  legacySlot(input: { name: string; props: Wire.JsonValue }): Outcome<ReactElement>
}

export interface ShellServices {
  readonly commands: DomainCommandClient
  readonly interactions: InteractionClient
  readonly control: SessionControlClient
  readonly approvals: ApprovalClient
  readonly artifacts: ArtifactClient
  readonly registry: UIRegistry
  readonly presentation: ClientPresentation
  readonly conversation: ShellConversationClient
  readonly domains: ShellDomainClient
  navigate(target: { sessionId: string; viewId?: string }): Promise<Outcome<void>>
}

export interface ShellProvider {
  readonly descriptor: {
    id: string
    apiMajor: 1
    stateSchema: Wire.SchemaRef
    requiredRegions: Array<'conversation' | 'composer' | 'resources' | 'interactions' | 'settings'>
  }
  mount(input: {
    container: HTMLElement
    snapshot: Wire.ShellSnapshot
    services: ShellServices
    ownerToken: string
    signal: AbortSignal
  }): Promise<Outcome<void>>
  update(snapshot: Wire.ShellSnapshot): Promise<Outcome<void>>
  exportState(): Promise<Outcome<Wire.ShellViewState>>
  importState(state: Wire.ShellViewState): Promise<Outcome<void>>
  stopAdmission(): void
  dispose(reason: 'switch' | 'shutdown' | 'fault'): Promise<Outcome<void>>
}

export interface ClientContribution {
  dispose(): Promise<void>
}

export interface ClientHost {
  readonly context: RendererContext
  readonly renderers: UIRegistry
  readonly presentation: ClientPresentation
  registerShell(factory: () => ShellProvider): Outcome<ClientContribution>
  observeCatalog(listener: (revision: number) => void): ClientContribution
}

export type ClientEntry = (host: ClientHost) => Promise<Outcome<ClientContribution>>
