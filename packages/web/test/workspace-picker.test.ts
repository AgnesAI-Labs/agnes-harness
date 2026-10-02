/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { requestWorkspacePicker, workspacePickerAvailable } from '../src/workspace-picker.js'
import { setLocaleTranslator } from '../src/locale-bridge.js'
import { zhT } from './helpers/locale.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)


describe('workspace picker client', () => {
  it('checks capability without a browser credential', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ available: true }), { status: 200 }),
    )
    await expect(workspacePickerAvailable(fetcher)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/workspace-picker',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
      }),
    )
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined()
  })

  it('returns selected and cancelled outcomes and keeps unavailable as a manual fallback', async () => {
    await expect(
      requestWorkspacePicker(
        vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify({ status: 'selected', path: '/tmp/工作区' }), { status: 200 }),
        ),
      ),
    ).resolves.toEqual({ status: 'selected', path: '/tmp/工作区' })
    await expect(
      requestWorkspacePicker(
        vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 }),
        ),
      ),
    ).resolves.toEqual({ status: 'cancelled' })
    await expect(
      requestWorkspacePicker(
        vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify({ status: 'unavailable' }), { status: 503 }),
        ),
      ),
    ).resolves.toEqual({ status: 'unavailable' })
  })

  it('fails closed on malformed or unauthenticated results', async () => {
    await expect(
      requestWorkspacePicker(
        vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify({ status: 'selected', path: '' }), { status: 200 }),
        ),
      ),
    ).rejects.toThrow('无法确认')
    await expect(
      requestWorkspacePicker(
        vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', detail: 'secret' } }), {
              status: 401,
            }),
        ),
      ),
    ).rejects.toThrow('无法确认')
  })
})
