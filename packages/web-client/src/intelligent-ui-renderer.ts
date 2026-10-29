import type { JsonValue } from '@agnes/protocol'

/** Available only inside an opaque-origin Intelligent UI component frame. */
export interface IntelligentUiRendererApi {
  emitAction(id: string): void
  readTheme(): 'light' | 'dark'
  readLocale(): 'en' | 'zh-CN'
}
/** Export `renderers`, keyed by the manifest's exact namespaced kind. Bundle without runtime imports. */
export type IntelligentUiRenderer = (
  mount: HTMLElement,
  props: JsonValue,
  api: IntelligentUiRendererApi,
) => void | (() => void) | Promise<void | (() => void)>
