import type { ApplicationState } from '@agnes/protocol'
import { PluginAdminApi } from '@agnes/web-admin/admin/plugins/api'
import {
  Button,
  createRegionRenderer,
  Icon,
  SettingsCode,
  SettingsGroup,
  SettingsItem,
  SettingsState,
  SettingsTag,
  type SettingsTagTone,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'

const clearCommand = 'agh app clear'
const hostName = 'Agnes Harness'
/** Host-only recovery: no client modules, application assets, navigation or skin imports. */
const zh = document.documentElement.lang === 'zh-CN'
const text = (en: string, cn: string) => (zh ? cn : en)

type Read = { api: PluginAdminApi; state: ApplicationState }

/** One backend read behind the first load, the retry after a read failure and the re-read after a conflict. */
async function read(): Promise<Read> {
  const api = new PluginAdminApi(await PluginAdminApi.context())
  return { api, state: await api.application() }
}

function statusTag(state: ApplicationState): { tone: SettingsTagTone; label: string } {
  if (state.status === 'active') return { tone: 'ok', label: text('In use', '使用中') }
  if (state.status === 'host') return { tone: 'muted', label: text('Official interface', '宿主界面') }
  return { tone: 'error', label: text('Not loaded', '未载入') }
}

function roleOverrides(count: number): string {
  if (count === 0) return text('Default', '默认')
  return zh ? `${count} 项按角色指定` : `${count} ${count === 1 ? 'role override' : 'role overrides'}`
}

function hasNothingToClear(state: ApplicationState): boolean {
  return state.selection === null && Object.keys(state.roleSelections ?? {}).length === 0
}

/**
 * Host-only application recovery at `/?admin`. It stays on the page after clearing so the outcome is
 * visible, and the fallback command stays outside the card: it is the exit when the backend is gone.
 */
export function Recovery() {
  const [snapshot, setSnapshot] = useState<Read>()
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState('')
  const [clearError, setClearError] = useState('')
  const [restored, setRestored] = useState(false)
  const [pending, setPending] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const load = useCallback(async () => {
    setReading(true)
    setReadError('')
    try {
      const next = await read()
      if (!live.current) return
      setSnapshot(next)
      setClearError('')
    } catch {
      if (live.current)
        setReadError(
          text(
            'Recovery is unavailable. Check that the backend is running, then retry.',
            '恢复管理暂时连不上。检查后端是否在运行，然后重试。',
          ),
        )
    } finally {
      if (live.current) setReading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const state = snapshot?.state
  const hostOnly = state !== undefined && hasNothingToClear(state)
  const canClear =
    state !== undefined &&
    !hostOnly &&
    !reading &&
    !pending &&
    !restored &&
    readError === '' &&
    clearError === ''
  const clear = async () => {
    if (!snapshot || !canClear) return
    setPending(true)
    setClearError('')
    try {
      const state = await snapshot.api.clearApplication(snapshot.state.revision)
      setSnapshot({ api: snapshot.api, state })
      setReadError('')
      setClearError('')
      setRestored(true)
    } catch {
      setClearError(
        text(
          'The selection changed or could not be cleared. Read it again and retry.',
          '选择已变更或清除失败。重新读取后再试。',
        ),
      )
    } finally {
      setPending(false)
    }
  }
  const mark = state && statusTag(state)
  const overrides = state ? Object.keys(state.roleSelections ?? {}).length : 0
  return (
    <main id="main-content" className="recovery-page">
      <div className="recovery-column">
        <header className="recovery-header">
          <p className="recovery-brand">{hostName}</p>
          <h1>{text('Application recovery', '应用恢复')}</h1>
          <p className="recovery-lede">
            {text(
              "When the application's interface fails to load, return to the official interface here. No application modules run on this page.",
              '工作台的界面实现没能载入时，在这里回到官方界面。此页面不加载任何应用模块。',
            )}
          </p>
        </header>

        <section className="recovery-panel" aria-labelledby="recovery-panel-title">
          <div className="recovery-panel-head">
            <h2 id="recovery-panel-title">{text('Current selection', '当前选择')}</h2>
            {mark && <SettingsTag tone={mark.tone}>{mark.label}</SettingsTag>}
          </div>

          {reading && (
            <SettingsState tone="loading">
              {text('Reading the current selection…', '正在读取当前选择…')}
            </SettingsState>
          )}

          {state && (
            <SettingsGroup>
              <SettingsItem label={text('Application', '应用')}>
                {state.selection?.packageId ?? text('No application selected', '未选择应用')}
              </SettingsItem>
              <SettingsItem label={text('Interfaces', '界面实现')}>{roleOverrides(overrides)}</SettingsItem>
              {state.status === 'unresolved' && state.reason && (
                <SettingsItem label={text('Reason', '原因')}>{state.reason}</SettingsItem>
              )}
            </SettingsGroup>
          )}

          {readError && (
            <SettingsState tone="error">
              {readError}{' '}
              <Button
                size="small"
                icon={<Icon name="refresh-cw" />}
                disabled={reading}
                onClick={() => void load()}
              >
                {text('Retry', '重试')}
              </Button>
            </SettingsState>
          )}

          {clearError && (
            <SettingsState tone="error">
              {clearError}{' '}
              <Button
                size="small"
                icon={<Icon name="refresh-cw" />}
                disabled={reading}
                onClick={() => void load()}
              >
                {text('Read again', '重新读取')}
              </Button>
            </SettingsState>
          )}

          {restored && (
            <SettingsState tone="success">
              {text('Official interface restored.', '已恢复官方界面。')}
            </SettingsState>
          )}

          <p className="recovery-note">
            {text(
              'Clearing affects interface choices only. Conversations, workspaces and runtime settings stay as they are.',
              '清除只影响界面实现的选择，对话、工作区和运行设置都会保留。',
            )}
          </p>
          <div className="recovery-actions">
            <Button
              appearance="primary"
              loading={pending}
              disabled={!canClear}
              {...(hostOnly
                ? {
                    disabledReason: text('The official interface is already in use.', '当前已经是官方界面'),
                  }
                : {})}
              onClick={() => void clear()}
            >
              {text('Restore official interface', '恢复官方界面')}
            </Button>
            <a
              className="recovery-return"
              href="/"
              aria-disabled={pending || undefined}
              onClick={(event) => {
                if (pending) event.preventDefault()
              }}
            >
              {text('Return to workbench', '返回工作台')}
            </a>
          </div>
        </section>

        <section className="recovery-fallback">
          <h2>{text('If this page cannot load', '页面打不开时')}</h2>
          <p>{text('Run the same command from a terminal:', '在终端运行同一条命令：')}</p>
          <SettingsCode
            label={text('Clear application and interface choices', '清除应用与界面实现选择')}
            copy={clearCommand}
          >
            {clearCommand}
          </SettingsCode>
        </section>
      </div>
    </main>
  )
}
document.title = text('Application recovery · Agnes Harness', '应用恢复 · Agnes Harness')
createRegionRenderer(document.body).render(<Recovery />)
