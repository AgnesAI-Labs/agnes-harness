import type {
  UiActionParams,
  UiActionReceipt,
  UiReadParams,
  UiReadResult,
} from '@agnes/protocol/gen/intelligent-ui'

/** Narrow authenticated App Server port; never dispatches a tool directly. */
export interface IntelligentUiServer {
  read(params: UiReadParams): Promise<UiReadResult>
  action(params: UiActionParams): Promise<UiActionReceipt>
  listen(onEvent: (event: { seq: number; type: string }) => void, onGap: () => void): () => void
  attach(afterSeq: number): Promise<void>
}
export interface UiCommandStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
