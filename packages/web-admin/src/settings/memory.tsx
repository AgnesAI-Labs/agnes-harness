import type { AdminMemoryResult, MemoryFile, MemorySettings } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Button,
  Field,
  SettingsCard,
  SettingsCode,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { contextRequest } from './context.js'
import { memoryRequest } from './memory-api.js'
import { memoryCatalog } from './memory-locale.js'

const errorEnvelope = (error: unknown) => (error as { envelope?: unknown })?.envelope ?? true

export function MemoryPanel({ canSave }: { canSave: boolean }) {
  const { t, locale } = useUiText('@agnes/web/memory', memoryCatalog)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [workspaces, setWorkspaces] = useState<{ path: string; available: boolean }[]>([])
  const [cwd, setCwd] = useState('')
  const [snapshot, setSnapshot] = useState<AdminMemoryResult>()
  const [file, setFile] = useState<MemoryFile>()
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const [saved, setSaved] = useState(false)
  const showError = (error: unknown) => setError(errorEnvelope(error))
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    void contextRequest({}, fetch, abort.signal)
      .then(async ({ workspaces }) => {
        if (abort.signal.aborted) return
        setWorkspaces(workspaces)
        const path = workspaces.find((workspace) => workspace.available)?.path
        if (!path) return
        setCwd(path)
        setSnapshot(await memoryRequest({ cwd: path }, abort.signal))
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(errorEnvelope(error))
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [])

  async function request(input: Parameters<typeof memoryRequest>[0]) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const result = await memoryRequest(input, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted) return
      setSnapshot(result)
      if (result.file) {
        setFile(result.file)
        setContent(result.file.content)
      }
      setSaved(input.settings !== undefined || input.content !== undefined)
    } catch (error) {
      if (!lifetime.current?.signal.aborted) showError(error)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const inspection = snapshot?.inspection
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  return (
    <SettingsCard title={t('title')} data-testid="memory-panel" aria-busy={busy}>
      <p>{t('help')}</p>
      <p>{t('privacy')}</p>
      {Boolean(error) && (
        <SettingsState tone="error" role="alert" data-testid="memory-error">
          {appServerErrorMessage(error, locale) ?? t('failed')}
        </SettingsState>
      )}
      {saved && (
        <SettingsState tone="success" role="status" data-testid="memory-saved">
          {t('saved')}
        </SettingsState>
      )}
      {!workspaces.some((workspace) => workspace.available) && !busy && (
        <SettingsState>{t('noWorkspace')}</SettingsState>
      )}
      <Field htmlFor="memory-workspace" label={t('workspace')}>
        <SettingsSelect
          id="memory-workspace"
          data-testid="memory-workspace"
          value={cwd}
          disabled={busy}
          onChange={(event) => {
            const path = event.target.value
            setCwd(path)
            setFile(undefined)
            void request({ cwd: path })
          }}
        >
          {!cwd && <option value="">{t('choose')}</option>}
          {workspaces.map((workspace) => (
            <option key={workspace.path} value={workspace.path} disabled={!workspace.available}>
              {workspace.path}
            </option>
          ))}
        </SettingsSelect>
      </Field>
      {inspection && (
        <>
          <Field htmlFor="memory-mode" label={t('permission')}>
            <SettingsSelect
              id="memory-mode"
              data-testid="memory-mode"
              value={inspection.settings.mode}
              disabled={!canSave || busy}
              onChange={(event) =>
                void request({ cwd, settings: { mode: event.target.value as MemorySettings['mode'] } })
              }
            >
              <option value="off">{t('off')}</option>
              <option value="ask">{t('ask')}</option>
              <option value="auto">{t('auto')}</option>
            </SettingsSelect>
          </Field>
          <p>{t('offHelp')}</p>
          <p data-testid="memory-size">
            {t('size', {
              used: numbers.format(
                (inspection.files.find((file) => file.path === 'MEMORY.md')?.bytes ?? 0) / 1024,
              ),
              limit: numbers.format(inspection.settings.indexMaxBytes / 1024),
              lines: numbers.format(inspection.settings.indexMaxLines),
            })}
          </p>
          <p>{t('budget', { tokens: numbers.format(inspection.settings.tokenBudget) })}</p>
          <SettingsCode label={t('location')} data-testid="memory-root">
            {inspection.root}
          </SettingsCode>
          {inspection.lastWriter && (
            <p data-testid="memory-writer">
              {t('writer')}: {inspection.lastWriter.sessionKey} · {inspection.lastWriter.turn}
            </p>
          )}
          <Button
            data-testid="memory-open"
            disabled={busy}
            onClick={() => void request({ cwd, file: 'MEMORY.md' })}
          >
            {t('open')}
          </Button>
          {file && (
            <>
              <Field htmlFor="memory-file" label={t('file')}>
                <SettingsSelect
                  id="memory-file"
                  data-testid="memory-file"
                  disabled={busy}
                  value={file.path}
                  onChange={(event) => void request({ cwd, file: event.target.value })}
                >
                  {[...new Set(['MEMORY.md', ...inspection.files.map((file) => file.path)])].map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </SettingsSelect>
              </Field>
              <Field htmlFor="memory-content" label={t('editor')}>
                <SettingsTextArea
                  id="memory-content"
                  data-testid="memory-content"
                  rows={10}
                  value={content}
                  disabled={!canSave || busy}
                  onChange={(event) => {
                    setContent(event.target.value)
                    setSaved(false)
                  }}
                />
              </Field>
              <p>{t('conflict')}</p>
              <SettingsToolbar data-testid="memory-actions">
                <Button
                  data-testid="memory-save"
                  disabled={!canSave || busy || content === file.content}
                  onClick={() => void request({ cwd, file: file.path, content, baseHash: file.hash })}
                >
                  {t('save')}
                </Button>
                <Button
                  data-testid="memory-reload"
                  disabled={busy}
                  onClick={() => void request({ cwd, file: file.path })}
                >
                  {t('reload')}
                </Button>
              </SettingsToolbar>
            </>
          )}
        </>
      )}
    </SettingsCard>
  )
}
