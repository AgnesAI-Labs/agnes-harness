import type { UINode, UITurn } from '@agnes/protocol'

/** Whether older records exist before the loaded window, and how to load a page of them. */
export type TranscriptMeta = { hasEarlier: boolean; loadEarlier?: () => void }

/** The commands a controller issues to the transcript region; the React host owns every node. */
export interface TranscriptHandle {
  render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TranscriptMeta): void
  reset(): void
  pinToBottom(): void
}
