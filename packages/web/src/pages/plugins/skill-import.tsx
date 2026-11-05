import type { SkillImportParams, SkillImportResult } from '@agnes/protocol'
import { Button, Dialog, MetaText, SettingsDetails, SettingsState, SettingsToolbar } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginView } from './admin-view.js'
import { McpImportReview } from './mcp-import-review.js'
import { SkillCandidates } from './skill-candidates.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
const pending = (result?: SkillImportResult) => result?.state === 'running'

/** Explicit community-install progress is the scoped product exception to page-based editing. */
function useSkillInstall({
  view,
  initialSource,
  onClose,
}: {
  view: PluginView
  initialSource: string
  t: Text
  onClose(): void
}) {
  const [result, setResult] = useState<SkillImportResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const initialChoices = useRef(false)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [testConnection, setTestConnection] = useState(false)
  const [mcpSandboxProfile, setMcpSandboxProfile] =
    useState<NonNullable<SkillImportParams['mcpSandboxProfile']>>('strict')
  const [rollbackRequested, setRollbackRequested] = useState(false)
  const api = view.api
  const current = useRef<SkillImportResult>()
  const active = useRef(false)
  const accept = useCallback((next: SkillImportResult) => {
    if (next.kind === 'mcp' && next.state === 'prepared' && next.mcp) {
      const available = next.mcp.skills.filter((row) => row.state === 'prepared').map((row) => row.path)
      const initial = !initialChoices.current
      initialChoices.current = true
      setSelectedSkills((previous) =>
        initial ? available : previous.filter((path) => available.includes(path)),
      )
      setSelectedServers(next.mcp.servers.filter((row) => row.selected).map((row) => row.serverId))
    }
    current.current = next
    setResult(next)
  }, [])
  const cancel = useCallback(
    async (value = current.current) => {
      if (value?.proposalId && ['prepared', 'running'].includes(value.state))
        await api?.skillImport({ action: 'cancel', proposalId: value.proposalId })
    },
    [api],
  )
  useEffect(() => {
    if (!api) return
    let mounted = true
    active.current = true
    setBusy(true)
    void api
      .skillImport({
        action: 'check',
        source: { type: 'git', ref: initialSource },
        scope: 'user',
        enable: false,
      })
      .then((next) => {
        if (mounted) accept(next)
        else if (next.proposalId)
          void api.skillImport({ action: 'cancel', proposalId: next.proposalId }).catch(() => undefined)
      })
      .catch(() => {
        if (mounted) setError('skill.import.failed')
      })
      .finally(() => {
        if (mounted) setBusy(false)
      })
    return () => {
      mounted = false
      active.current = false
      void cancel().catch(() => undefined)
    }
  }, [api, initialSource, accept, cancel])
  useEffect(() => {
    if (error || result?.state !== 'running' || !result?.proposalId || !api) return
    const proposalId = result.proposalId
    let mounted = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.skillImport({ action: 'status', proposalId })
        if (!mounted) return
        accept(next)
        if (pending(next) && next.proposalId === proposalId) timer = setTimeout(poll, 700)
      } catch {
        if (mounted) setError('skill.import.failed')
      }
    }
    timer = setTimeout(poll, 300)
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [api, result?.state, result?.proposalId, error, accept])
  const run = async (action: 'check' | 'commit' | 'rollback', subdirectory?: string) => {
    if (!api || busy) return
    const value = current.current
    if (action === 'commit' && (value?.state !== 'prepared' || !value.proposalId || !value.digest)) return
    if (action === 'rollback' && (!value?.proposalId || !value.digest)) return
    setBusy(true)
    setError('')
    try {
      if (action === 'check') {
        await cancel(value)
        setTestConnection(false)
      }
      const next = await api.skillImport(
        action === 'check'
          ? {
              action,
              source: value?.resolvedSource ?? { type: 'git', ref: initialSource },
              ...(subdirectory ? { subdirectory } : {}),
              scope: 'user',
              enable: false,
              ...(Object.keys(bindings).length ? { credentialBindings: bindings } : {}),
              mcpSandboxProfile,
              ...(value?.kind === 'mcp' ? { mcpServers: selectedServers } : {}),
            }
          : {
              action,
              ...(value?.proposalId ? { proposalId: value.proposalId } : {}),
              ...(value?.digest ? { expectedDigest: value.digest } : {}),
              ...(action === 'commit' && value?.kind === 'mcp'
                ? { skillDirectories: selectedSkills, mcpServers: selectedServers, testConnection }
                : {}),
            },
      )
      if (active.current) accept(next)
      else await cancel(next)
    } catch {
      if (active.current) setError('skill.import.failed')
    } finally {
      if (active.current) setBusy(false)
    }
  }
  const close = async () => {
    if (busy) return
    setBusy(true)
    try {
      await cancel()
      if (current.current?.kind === 'mcp' && current.current.state !== 'prepared') {
        window.dispatchEvent(new Event('agnes:plugins-invalidated'))
        await view.refresh()
      }
      onClose()
    } catch {
      setError('skill.import.failed')
      setBusy(false)
    }
  }
  const phase = result?.phase
  const checking =
    pending(result) && ['acquiring', 'identifying', 'validating', 'environment'].includes(phase ?? '')
  const retry = () => {
    if (error && pending(result)) setError('')
    else void run('check')
  }
  return {
    mcpSandboxProfile,
    setMcpSandboxProfile,
    mcpConfigurationChanged:
      !!result?.mcp &&
      (JSON.stringify([...selectedServers].sort()) !==
        JSON.stringify(
          result.mcp.servers
            .filter((server) => server.selected)
            .map((server) => server.serverId)
            .sort(),
        ) ||
        result.mcp.servers.some(
          (server) =>
            selectedServers.includes(server.serverId) &&
            server.transport === 'stdio' &&
            server.sandboxProfile !== mcpSandboxProfile,
        )),
    selectedServers,
    setSelectedServers,
    result,
    busy,
    error,
    checking,
    phase,
    run,
    close,
    retry,
    selectedSkills,
    setSelectedSkills,
    bindings,
    setBindings,
    testConnection,
    setTestConnection,
    rollbackRequested,
    setRollbackRequested,
  }
}

export function SkillInstallDialog(props: Parameters<typeof useSkillInstall>[0]) {
  const { t } = props
  const flow = useSkillInstall(props)
  const { result, busy, error, checking, phase, run, close } = flow
  const reasonKey = `skill.import.reason.${result?.message}`
  const reason = t(reasonKey) === reasonKey ? t('skill.import.failed') : t(reasonKey)
  return (
    <Dialog
      open
      size="lg"
      title={t('skill.import.title')}
      className="skill-install-dialog"
      onCancel={() => void close()}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: false }}
      footer={<SkillInstallActions {...flow} t={t} />}
    >
      <div aria-live="polite" aria-busy={busy || pending(result)}>
        <ol className="skill-install-steps" aria-label={t('skill.import.progress')}>
          {['check', 'review', 'install', 'done'].map((step, index) => (
            <li
              key={step}
              aria-current={
                index ===
                (!result || checking
                  ? 0
                  : result.state === 'prepared' || result.state === 'selection_required'
                    ? 1
                    : pending(result)
                      ? 2
                      : 3)
                  ? 'step'
                  : undefined
              }
            >
              {t(`skill.import.step.${step}`)}
            </li>
          ))}
        </ol>
        {(!result || checking) && !error && (
          <SettingsState tone="loading">{t(`skill.import.phase.${phase ?? 'acquiring'}`)}</SettingsState>
        )}
        {error && <SettingsState tone="error">{t(error)}</SettingsState>}
        {result && (
          <>
            {result.state !== 'selection_required' && (
              <p>
                <strong>{result.name}</strong>{' '}
                {!checking && t(`${result.kind === 'mcp' ? 'mcp' : 'skill'}.import.state.${result.state}`)}
              </p>
            )}
            {result.description && <p>{result.description}</p>}
            {result.message && (
              <SettingsState tone={result.state === 'failed' ? 'error' : 'empty'}>{reason}</SettingsState>
            )}
            {result.state === 'selection_required' && !result.candidates?.length && (
              <p>{t('skill.import.noSkills')}</p>
            )}
            {!!result.candidates?.length && (
              <SkillCandidates
                candidates={result.candidates}
                busy={busy}
                t={t}
                onSelect={(candidate) => void run('check', candidate)}
              />
            )}
            {result.state === 'prepared' && result.kind !== 'mcp' && <p>{t('skill.import.help')}</p>}
            {result.kind === 'mcp' && (
              <McpImportReview
                result={result}
                selectedServers={flow.selectedServers}
                onServers={(value) => {
                  flow.setSelectedServers(value)
                  flow.setTestConnection(false)
                }}
                configurationChanged={flow.mcpConfigurationChanged}
                selected={flow.selectedSkills}
                onSelected={flow.setSelectedSkills}
                bindings={flow.bindings}
                onBinding={(key, value) => flow.setBindings((previous) => ({ ...previous, [key]: value }))}
                test={flow.testConnection}
                onTest={flow.setTestConnection}
                busy={busy}
                sandboxProfile={flow.mcpSandboxProfile}
                onSandboxProfile={flow.setMcpSandboxProfile}
                canTest={
                  props.view.canEffect('packages.trust') &&
                  props.view.canEffect('packages.activate') &&
                  (result.mcp?.servers
                    .filter((server) => flow.selectedServers.includes(server.serverId))
                    .every((server) => server.credentialKind === 'none') ||
                    props.view.canEffect('credentials.read'))
                }
                onConfigure={() => void run('check')}
                t={t}
              />
            )}
            {flow.rollbackRequested && (
              <SettingsState tone="error">{t('mcp.import.rollbackHelp')}</SettingsState>
            )}
            {result.environment && (
              <>
                <h4>{t('skill.import.environment')}</h4>
                <ul>
                  {result.environment.map((item) => (
                    <li key={`${item.name}-${item.evidence}`}>
                      {item.name}
                      {item.required ? ` ${item.required}` : ''}：{t(`skill.import.env.${item.state}`)}
                      {item.actual ? ` (${item.actual})` : ''}
                    </li>
                  ))}
                </ul>
                <MetaText>{t('skill.import.unverified')}</MetaText>
              </>
            )}
            {result.files && (
              <SettingsDetails
                title={t('skill.import.files', { count: result.fileCount ?? result.files.length })}
              >
                <ul className="skill-import-files">
                  {result.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <MetaText>{result.digest}</MetaText>
                <MetaText>{result.resolvedSource?.ref}</MetaText>
              </SettingsDetails>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

function SkillInstallActions({
  result,
  busy,
  error,
  run,
  close,
  retry,
  rollbackRequested,
  setRollbackRequested,
  mcpConfigurationChanged,
  selectedServers,
  selectedSkills,
  t,
}: ReturnType<typeof useSkillInstall> & { t: Text }) {
  return (
    <SettingsToolbar>
      <Button disabled={busy} onClick={() => void close()}>
        {t(result?.state === 'prepared' || pending(result) ? 'skill.import.cancel' : 'skill.import.close')}
      </Button>
      {result?.state === 'prepared' && !error && (
        <Button
          appearance="primary"
          disabled={
            busy ||
            mcpConfigurationChanged ||
            (result.kind === 'mcp' && !selectedServers.length && !selectedSkills.length) ||
            !!result.mcp?.requiredCredentials.length ||
            !!result.mcp?.issues.length
          }
          onClick={() => void run('commit')}
        >
          {t('skill.import.confirm')}
        </Button>
      )}
      {(error || result?.state === 'failed' || result?.state === 'cancelled') && (
        <Button disabled={busy} onClick={retry}>
          {t('skill.import.retry')}
        </Button>
      )}
      {result?.kind === 'mcp' && ['installed', 'failed', 'interrupted'].includes(result.state) && (
        <Button
          disabled={busy}
          onClick={() => {
            if (rollbackRequested) void run('rollback')
            else setRollbackRequested(true)
          }}
        >
          {t(rollbackRequested ? 'mcp.import.confirmRollback' : 'mcp.import.rollback')}
        </Button>
      )}
    </SettingsToolbar>
  )
}
