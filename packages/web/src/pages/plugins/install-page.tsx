import { resolvePluginMetadata } from '@agnes/protocol'
import { ExampleManagementNotice, PluginInstallReview } from '@agnes/web-admin/admin/plugins/install-review'
import {
  PLUGIN_PRESENTATION_NAMESPACE,
  PushPage,
  pluginPresentationCatalog,
  usePushStack,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef } from 'react'
import type { PluginView } from './admin-view.js'
import { pluginPage, pluginPageId } from './route.js'

const LOCAL_SOURCES = new Set(['file', 'local', 'workspace', 'path'])

/**
 * A finished install or update check, as a page: 「插件 › 安装「<name>」」. It opens by itself when the
 * check is done (in place of the add form or the marketplace entry that asked), back cancels it,
 * and it closes once the confirmed operation has finished. A failure stays on it with a retry.
 */
export function InstallReviewPage({ view }: { view: PluginView | undefined }) {
  const pages = usePushStack()
  const nav = useRef(pages)
  nav.current = pages
  const { t: purposeText, locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const review = view?.review
  const segment = review ? pluginPageId({ kind: 'install', id: review.preview.id }) : undefined
  const shown = useRef<string>()
  const ready = !!view && !view.state.loading
  const cancel = view?.cancelReview
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of the stack is what makes this check again.
  useEffect(() => {
    const { stack } = nav.current
    if (segment) {
      if (shown.current === segment) {
        // Back, a breadcrumb or the browser left the review: nothing is installed.
        if (!stack.includes(segment)) {
          // The controller commits synchronously; let this commit finish first.
          let current = true
          queueMicrotask(() => {
            if (current && !nav.current.stack.includes(segment)) {
              shown.current = undefined
              cancel?.()
            }
          })
          return () => {
            current = false
          }
        }
        return
      }
      // An earlier snapshot while opening is not a back step. Mark it shown only after commit.
      if (stack.includes(segment)) {
        shown.current = segment
        return
      }
      const top = stack.at(-1)
      const kind = top ? pluginPage(top)?.kind : undefined
      // The form or entry that asked has done its part; back from the review leaves the flow.
      if (kind === 'add-plugin' || kind === 'market' || kind === 'install') nav.current.replace(segment)
      else nav.current.open(segment)
      return
    }
    const closed = shown.current
    shown.current = undefined
    if (closed && stack.at(-1) === closed) nav.current.back()
    // A link to a review that is no longer under way has nothing to show.
    else if (!closed && ready && pluginPage(stack.at(-1) ?? '')?.kind === 'install') nav.current.back()
  }, [segment, pages.stack, cancel, ready])
  if (!view || !review || !segment) return null
  const { preview } = review
  const name = resolvePluginMetadata(preview.metadata, locale)?.displayName ?? preview.id
  const kind = preview.provides?.[0]
  const origin =
    preview.presentation?.origin ?? (LOCAL_SOURCES.has(preview.source.type) ? 'local-source' : 'third-party')
  return (
    <PushPage id={segment} title={view.t(`preview.title.${review.mode}`, { id: name })}>
      {preview.metadata?.exampleOf ? (
        <ExampleManagementNotice view={view} preview={preview} />
      ) : (
        <PluginInstallReview
          review={review}
          name={name}
          kind={kind ? view.t(`kind.${kind}`) : undefined}
          tier={purposeText(`origin.${origin}`)}
          t={view.t}
          onCancel={() => nav.current.back()}
          onReviewDependents={() => void view.reviewDependents()}
          onConfirm={(enableAfter) => void view.confirmReview(enableAfter)}
        />
      )}
    </PushPage>
  )
}
