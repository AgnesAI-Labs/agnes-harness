import type { HomeEntry } from '@agnes/web-client'
import { lazy, Suspense } from 'react'

/** Register navigation immediately; load a built-in page only when its route is selected. */
export function deferHomePage(
  load: () => Promise<{ default: HomeEntry['component'] }>,
): HomeEntry['component'] {
  const Page = lazy(load)
  return function DeferredHomePage(props) {
    return (
      <Suspense fallback={null}>
        <Page {...props} />
      </Suspense>
    )
  }
}
