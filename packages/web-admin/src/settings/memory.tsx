import { publicErrorCode } from '@agnes/protocol'
import type { AdminMemoryResult, MemoryFile, MemorySettings } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Banner,
  Button,
  fallbackT,
  reportSuccess,
  Segmented,
  SettingsBlock,
  SettingsDrill,
  SettingsItem,
  SettingsPickerSelect,
  SettingsTextArea,
  trackPageRequest,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { captureRequest } from './async-request.js'
import { contextRequest } from './context.js'
import { memoryRequest } from './memory-api.js'
import { MemoryEntriesBlock } from './memory-entries-block.js'
import { MemoryExpiryStatus } from './memory-expiry.js'
import { memoryCatalog } from './memory-locale.js'
import { SavedParagraphsBlock } from './memory-saved.js'

const errorEnvelope = (error: unknown) => (error as { envelope?: unknown })?.envelope ?? true
type Request = Parameters<typeof memoryRequest>[0]

/**
 * Memory on the General page: the workspace, whether the agent may remember (off / ask / auto), and a
 * Memory files subpage with the files, an editor that checks the version on save, and where it is kept.
 */
export function MemoryPanel({ canSave, visit = 1 }: { canSave: boolean; visit?: number }) {
  const { t, locale } = useUiText('@agnes/web/memory', memoryCatalog)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [workspaces, setWorkspaces] = useState<{ path: string; available: boolean }[]>([])
  const [cwd, setCwd] = useState('')
  const selectedCwd = useRef('')
  const [snapshotState, setSnapshotState] = useState<{ cwd: string; result: AdminMemoryResult }>()
  const snapshot = snapshotState?.cwd === cwd ? snapshotState.result : undefined
  const [file, setFile] = useState<MemoryFile>()
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  // A failed change is offered again from the group label; a failed file save shows in the editor.
  const [failedChange, setFailedChange] = useState<Request>()
  const [confirmDelete, setConfirmDelete] = useState<{ cwd: string; path: string; baseHash: string }>()
  const [fileError, setFileError] = useState<unknown>()
  const [reads, setReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(true)
    setReadFailed(false)
    setFailedChange(undefined)
    setConfirmDelete(undefined)
    setFileError(undefined)
    setFile(undefined)
    setContent('')
    setSnapshotState(undefined)
    void trackPageRequest(contextRequest({}, fetch, abort.signal))
      .then(async ({ workspaces }) => {
        if (abort.signal.aborted) return
        setWorkspaces(workspaces)
        const path =
          workspaces.find((workspace) => workspace.available && workspace.path === selectedCwd.current)
            ?.path ?? workspaces.find((workspace) => workspace.available)?.path
        if (!path) return
        selectedCwd.current = path
        setCwd(path)
        const value = await memoryRequest({ cwd: path }, abort.signal)
        if (!abort.signal.aborted) setSnapshotState({ cwd: path, result: value })
      })
      .catch(() => {
        if (!abort.signal.aborted) setReadFailed(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => lifetime.current?.abort()
  }, [reads, canSave])

  // Settings stay mounted while closed. On a later visit, re-read what an agent may have written
  // since; an open file is re-read only when it holds no unsaved edit.
  const firstVisit = useRef(visit)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new visit starts this read.
  useEffect(() => {
    if (visit === firstVisit.current || !selectedCwd.current) return
    void request({
      cwd: selectedCwd.current,
      ...(file && content === file.content ? { file: file.path } : {}),
    })
  }, [visit])

  async function request(input: Request, kind: 'read' | 'change' | 'file' = 'read') {
    if (busy || !input.cwd || input.cwd !== selectedCwd.current) return
    const request = captureRequest(lifetime)
    setBusy(true)
    setReadFailed(false)
    if (kind === 'change') setFailedChange(undefined)
    setConfirmDelete(undefined)
    setFileError(undefined)
    try {
      const result = await memoryRequest(input, request.signal)
      if (!request.isCurrent()) return
      setSnapshotState({ cwd: input.cwd, result })
      if (kind !== 'read') reportSuccess('memory', fallbackT('ui.settingsSaved'))
      if (input.deleteFile && input.deleteFile.path === file?.path) {
        setFile(undefined)
        setContent('')
      } else if (result.file) {
        setFile(result.file)
        setContent(result.file.content)
      }
    } catch (error) {
      if (!request.isCurrent()) return
      if (kind === 'change') setFailedChange(input)
      else if (kind === 'file') setFileError(errorEnvelope(error))
      else setReadFailed(true)
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const inspection = snapshot?.inspection
  const index = inspection?.files.find((entry) => entry.path === 'MEMORY.md')
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const used = numbers.format((index?.bytes ?? 0) / 1024)
  const limit = numbers.format((inspection?.settings.indexMaxBytes ?? 0) / 1024)
  const files = inspection ? [...new Set(['MEMORY.md', ...inspection.files.map((entry) => entry.path)])] : []
  const mode = failedChange?.settings?.mode ?? inspection?.settings.mode
  const noWorkspace = !busy && !workspaces.some((workspace) => workspace.available)
  return (
    <SettingsBlock
      label={t('title')}
      data-testid="memory-panel"
      aria-busy={busy}
      failed={!!failedChange}
      onRetry={() => failedChange && void request(failedChange, 'change')}
      state={readFailed ? 'error' : busy && !snapshot && !noWorkspace ? 'loading' : undefined}
      onReload={() => setReads((value) => value + 1)}
    >
      {noWorkspace ? (
        <SettingsItem label={t('noWorkspace')} data-testid="memory-no-workspace" />
      ) : (
        <SettingsItem label={t('workspace')} info={t('workspaceHelp')}>
          <SettingsPickerSelect
            id="memory-workspace"
            data-testid="memory-workspace"
            label={t('workspace')}
            aria-label={t('workspace')}
            value={cwd}
            disabled={busy}
            onChange={(event) => {
              const path = event.target.value
              selectedCwd.current = path
              setCwd(path)
              lifetime.current?.abort()
              lifetime.current = new AbortController()
              setSnapshotState(undefined)
              setFile(undefined)
              setContent('')
              setConfirmDelete(undefined)
              setFileError(undefined)
              setFailedChange(undefined)
              void request({ cwd: path })
            }}
          >
            {!cwd && <option value="">{t('choose')}</option>}
            {workspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path} disabled={!workspace.available}>
                {workspace.path}
              </option>
            ))}
          </SettingsPickerSelect>
        </SettingsItem>
      )}
      {inspection && mode && (
        <SettingsItem label={t('permission')} info={`${t('help')} ${t('offHelp')}`}>
          <Segmented<MemorySettings['mode']>
            label={t('permission')}
            testId="memory-mode"
            value={mode}
            disabled={!canSave || busy}
            options={[
              { value: 'off', label: t('off'), testId: 'memory-mode-off' },
              { value: 'ask', label: t('ask'), testId: 'memory-mode-ask' },
              { value: 'auto', label: t('auto'), testId: 'memory-mode-auto' },
            ]}
            onChange={(next) => void request({ cwd, settings: { mode: next } }, 'change')}
          />
        </SettingsItem>
      )}
      {inspection && (
        <SettingsDrill
          id="memory-files"
          icon="file-text"
          data-testid="memory-open"
          label={t('files')}
          hint={`${t('fileCount', { count: files.length })} · ${t('usedShort', { used, limit })}`}
          description={t('filesHelp')}
          // The open file's actions sit in the subpage's header line, beside ×.
          actions={
            file && (
              <>
                <Button
                  size="small"
                  data-testid="memory-reload"
                  disabled={busy}
                  onClick={() => void request({ cwd, file: file.path })}
                >
                  {t('reload')}
                </Button>
                <Button
                  size="small"
                  appearance="primary"
                  data-testid="memory-save"
                  disabled={!canSave || busy || content === file.content}
                  onClick={() => void request({ cwd, file: file.path, content, baseHash: file.hash }, 'file')}
                >
                  {t('save')}
                </Button>
              </>
            )
          }
          onClick={() => {
            if (!file) void request({ cwd, file: 'MEMORY.md' })
          }}
        >
          <SettingsBlock data-testid="memory-files">
            {files.map((path) => {
              const entry = inspection.files.find((item) => item.path === path)
              const deleteDisabled =
                !canSave || busy || !entry?.hash || (file?.path === path && content !== file.content)
              return (
                <SettingsItem
                  key={path}
                  icon="file"
                  label={<span translate="no">{path}</span>}
                  description={entry ? `${numbers.format(entry.bytes / 1024)} KB` : t('fileEmpty')}
                >
                  <Button
                    size="small"
                    data-testid={path === 'MEMORY.md' ? 'memory-open-index' : 'memory-open-file'}
                    disabled={busy || file?.path === path}
                    onClick={() => void request({ cwd, file: path })}
                  >
                    {t(file?.path === path ? 'opened' : 'openFile')}
                  </Button>
                  {path !== 'MEMORY.md' &&
                    (confirmDelete?.path === path ? (
                      <>
                        <Button
                          size="small"
                          data-testid="memory-delete-confirm"
                          disabled={deleteDisabled}
                          onClick={() => {
                            if (confirmDelete.cwd !== cwd || snapshotState?.cwd !== cwd) return
                            const { path, baseHash } = confirmDelete
                            void request({ cwd: confirmDelete.cwd, deleteFile: { path, baseHash } }, 'file')
                          }}
                        >
                          {t('confirmDelete')}
                        </Button>
                        <Button
                          size="small"
                          data-testid="memory-delete-cancel"
                          onClick={() => setConfirmDelete(undefined)}
                        >
                          {t('cancel')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        data-testid="memory-delete-file"
                        disabled={deleteDisabled}
                        onClick={() => entry?.hash && setConfirmDelete({ cwd, path, baseHash: entry.hash })}
                      >
                        {t('deleteFile')}
                      </Button>
                    ))}
                </SettingsItem>
              )
            })}
          </SettingsBlock>
          {Boolean(fileError) && (
            <Banner tone="error" role="alert" data-testid="memory-error">
              {appServerErrorMessage(fileError, locale) ?? t('failed')}
              {publicErrorCode(fileError) === 'MEMORY_MISSING_TOPIC' && ` ${t('entries.missingTopic')}`}
            </Banner>
          )}
          {file && (
            <SettingsBlock bare label={<span translate="no">{file.path}</span>} data-testid="memory-actions">
              <SettingsTextArea
                id="memory-content"
                data-testid="memory-content"
                aria-label={t('editor')}
                className="agnes-settings-code-input"
                rows={10}
                value={content}
                disabled={!canSave || busy}
                onChange={(event) => setContent(event.target.value)}
              />
              <MemoryExpiryStatus content={content} memoryOff={inspection.settings.mode === 'off'} />
            </SettingsBlock>
          )}
          {file && (
            <MemoryEntriesBlock
              key={JSON.stringify([cwd, file.path, file.hash])}
              content={file.content}
              disabled={!canSave || busy}
              dirty={content !== file.content}
              memoryOff={inspection.settings.mode === 'off'}
              onSave={(next) =>
                void request({ cwd, file: file.path, content: next, baseHash: file.hash }, 'file')
              }
            />
          )}
          {file && cwd && (
            <SavedParagraphsBlock
              key={cwd}
              refreshKey={`${index?.hash ?? ''}:${file.hash}:${visit}`}
              indexContent={file.path === 'MEMORY.md' ? file.content : undefined}
              memoryOff={inspection.settings.mode === 'off'}
              cwd={cwd}
              canSave={canSave}
              locale={locale}
              t={t}
              onFileChanged={() => {
                if (selectedCwd.current === cwd && file.path === 'MEMORY.md' && content === file.content)
                  void request({ cwd, file: file.path })
              }}
            />
          )}
          {file && cwd && (
            <SavedParagraphsBlock
              key={`${cwd}:user`}
              refreshKey={`${visit}:${file.hash}:${inspection.settings.userEnabled}`}
              cwd={cwd}
              canSave={canSave}
              locale={locale}
              t={t}
              layer="user"
              readsUser={inspection.settings.mode !== 'off' && inspection.settings.userEnabled}
              onFileChanged={() => undefined}
            />
          )}
          <SettingsBlock data-testid="memory-usage">
            <SettingsItem label={t('used')}>
              <span className="agnes-settings-value" data-testid="memory-size">
                {t('size', {
                  used,
                  limit,
                  lines: numbers.format(inspection.settings.indexMaxLines),
                })}
              </span>
            </SettingsItem>
            <SettingsItem label={t('budgetLabel')}>
              {/* Stored as UTF-8 bytes; the field keeps its old name for compatibility. */}
              <span className="agnes-settings-value" data-testid="memory-inject-limit">
                {t('budgetValue', { kb: (inspection.settings.tokenBudget / 1024).toFixed(1) })}
              </span>
            </SettingsItem>
            <SettingsItem label={t('location')}>
              <span
                className="agnes-settings-value agnes-settings-value-path"
                translate="no"
                data-testid="memory-root"
              >
                {inspection.root}
              </span>
            </SettingsItem>
            <SettingsItem label={t('writer')}>
              <span className="agnes-settings-value" data-testid="memory-writer">
                {inspection.lastWriter
                  ? `${inspection.lastWriter.sessionKey} · ${inspection.lastWriter.turn}`
                  : '—'}
              </span>
            </SettingsItem>
          </SettingsBlock>
          <p className="agnes-settings-note">{t('conflict')}</p>
          <p className="agnes-settings-note">{t('privacy')}</p>
        </SettingsDrill>
      )}
    </SettingsBlock>
  )
}
