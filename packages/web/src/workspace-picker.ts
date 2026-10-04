import type { Translate } from './presentation.js'

export type WorkspacePickerResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }

type Fetcher = typeof fetch

export async function workspacePickerAvailable(fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const response = await fetcher('/api/workspace-picker', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) return false
    const body = (await response.json()) as { available?: unknown }
    return body.available === true
  } catch {
    return false
  }
}

export async function requestWorkspacePicker(
  t: Translate,
  fetcher: Fetcher = fetch,
): Promise<WorkspacePickerResult> {
  const response = await fetcher('/api/workspace-picker', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
  })
  let body: { status?: unknown; path?: unknown }
  try {
    body = (await response.json()) as typeof body
  } catch {
    throw new Error(t('settings.workspacePicker.ambiguous'))
  }
  if (body.status === 'cancelled') return { status: 'cancelled' }
  if (body.status === 'unavailable') return { status: 'unavailable' }
  if (
    response.ok &&
    body.status === 'selected' &&
    typeof body.path === 'string' &&
    body.path.length > 0 &&
    body.path.length <= 4096 &&
    !body.path.includes('\0')
  )
    return { status: 'selected', path: body.path }
  throw new Error(t('settings.workspacePicker.ambiguous'))
}
