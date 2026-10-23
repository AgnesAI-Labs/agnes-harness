import type { ResourceOperation } from '@agnes/protocol'
import { type OperationFeedback, publishFeedback, resolveFeedback, type Translate } from '@agnes/web-ui'

export type ResourceCompletion = { message: string; effect?: OperationFeedback['effect'] }
export function reportResourceCompleted(
  operation: ResourceOperation,
  t: Translate,
  completion?: ResourceCompletion,
): void {
  if (operation.state !== 'succeeded') return
  if (operation.kind === '_agnes/v1/skills.refresh') resolveFeedback('skill-folders')
  if (['_agnes/v1/mcp.servers.enable', '_agnes/v1/mcp.servers.remove'].includes(operation.kind))
    resolveFeedback(`resource:${operation.target}`)
  publishFeedback({
    id: operation.operationId,
    scope: `resource:${operation.target}`,
    outcome: 'success',
    message: completion?.message ?? t('notice.succeeded'),
    ...(completion?.effect ? { effect: completion.effect } : {}),
  })
}

/** Notices belong to the page that created them; navigation also retires late completions. */
export class ResourcePageFeedback {
  #revision = 0
  readonly #scopes = new Set<string>()
  capture() {
    const revision = this.#revision
    return (operation: ResourceOperation, t: Translate, completion?: ResourceCompletion): boolean => {
      if (revision !== this.#revision) return false
      if (operation.state === 'succeeded') this.#scopes.add(`resource:${operation.target}`)
      reportResourceCompleted(operation, t, completion)
      return true
    }
  }
  clear(): void {
    this.#revision++
    for (const scope of this.#scopes) resolveFeedback(scope)
    this.#scopes.clear()
  }
}
