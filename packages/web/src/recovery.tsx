const clearCommand = 'agh app clear'

import type { ApplicationState } from '@agnes/protocol'
import { PluginAdminApi } from '@agnes/web-admin/admin/plugins/api'
import { Button, createRegionRenderer, SettingsBlock } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

const hostName = 'Agnes Harness'
const zh = document.documentElement.lang === 'zh-CN'
const text = (en: string, cn: string) => (zh ? cn : en)
/** Host-only recovery: no client modules, application assets, navigation or skin imports. */
export function Recovery() {
  const [state, setState] = useState<ApplicationState>()
  const [api, setApi] = useState<PluginAdminApi>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void PluginAdminApi.context()
      .then(async (context) => {
        const api = new PluginAdminApi(context)
        const current = await api.application()
        if (live) {
          setApi(api)
          setState(current)
        }
      })
      .catch(() => {
        if (live)
          setError(
            text(
              'Recovery is unavailable. Retry or run agh app clear.',
              '恢复管理暂不可用，请重试或运行 agh app clear。',
            ),
          )
      })
    return () => {
      live = false
    }
  }, [])
  const clear = async () => {
    if (!api || !state || pending) return
    setPending(true)
    setError('')
    try {
      setState(await api.clearApplication(state.revision))
    } catch {
      setError(
        text(
          'The selection changed or could not be cleared. Reload and try again.',
          '选择已变更或清除失败，请重新加载后重试。',
        ),
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <main id="main-content">
      <h1>{hostName}</h1>
      <h2>{text('Application recovery', '应用恢复')}</h2>
      <SettingsBlock state={!state ? (error ? 'error' : 'loading') : undefined}>
        <p>
          {text(
            'This page uses the host identity and skin. Application modules do not run here.',
            '此页面使用宿主品牌和皮肤，应用模块不会在此运行。',
          )}
        </p>
        {state && (
          <p>
            {state.selection?.packageId ?? 'Agnes Harness'} · {state.status}
            {state.reason ? ` · ${state.reason}` : ''}
          </p>
        )}
        {error && state && <p role="alert">{error}</p>}
        <Button disabled={!state || !api || pending} onClick={() => void clear()}>
          {text('Clear current application', '清除当前应用')}
        </Button>
        <p>
          <a href="/">{text('Return to workbench', '返回工作台')}</a>
        </p>
        <p>
          <code>{clearCommand}</code>
        </p>
      </SettingsBlock>
    </main>
  )
}
document.title = hostName
createRegionRenderer(document.body).render(<Recovery />)
