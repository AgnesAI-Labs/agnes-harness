import type { ApprovalGrantRecord, SessionRuntimeDescriptor, SessionToolsResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { Translate } from '@agnes/web-conversation/presentation'
import {
  Button,
  createRegionHost,
  Dialog,
  ListRow,
  MetaText,
  renderRegion,
  SettingsGroup,
  SettingsItem,
  SettingsList,
  SettingsTechnicalDetails,
  Tag,
  unmountRegion,
  useDocumentLanguage,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import {
  defaultGrantBinding,
  readSessionGrants,
  SessionGrantList,
  type SessionGrants,
  SessionToolList,
} from './session-runtime-sections.js'

type Pending = NonNullable<SessionRuntimeDescriptor['providers'][number]['pending']>
const effectKey = (effect: Pending['effect']) =>
  effect === 'restart-required' ? 'session.runtime.effect.restart' : 'session.runtime.effect.newSessions'

const PRESET_KEYS: Record<string, string> = {
  'read-only': 'session.runtime.permission.view',
  'workspace-write': 'session.runtime.permission.workspace',
  'full-access': 'session.runtime.permission.full',
  standard: 'session.runtime.permission.standard',
}

/**
 * What a session runs, in plain words first: how it works, which model, what it may do and whether
 * a newer version exists. Identifiers and provider tables stay under technical details. Nothing is
 * derived here beyond naming what the Host's descriptors already state.
 */
export function RuntimeInfo({
  runtime,
  tools,
  loopLabel,
  children,
  t,
}: {
  runtime: SessionRuntimeDescriptor
  tools?: SessionToolsResult | undefined
  loopLabel?: string | undefined
  children?: ReactNode
  t: Translate
}) {
  const { generation, policy, resources } = runtime
  const capabilities = tools?.capabilities
  const unknown = t('session.runtime.unknown')
  const unloaded = <MetaText>{t('session.runtime.unloaded')}</MetaText>
  const pendingTag = (pending: Pending | undefined) =>
    pending ? (
      <Tag tone="warn">
        {t('session.runtime.pending', { target: pending.id, effect: t(effectKey(pending.effect)) })}
      </Tag>
    ) : undefined
  const loop = runtime.loop ?? capabilities?.loop.value
  const model = capabilities?.modelRoutes.value?.primary.model
  const preset = capabilities?.permissions.preset ?? runtime.preset?.name
  const presetKey = preset ? PRESET_KEYS[preset] : undefined
  const readOnly = capabilities?.permissions.readOnly ?? policy?.readOnly
  const permission = preset
    ? [
        presetKey ? t(presetKey) : preset,
        readOnly && preset !== 'read-only' ? t('session.runtime.permission.view') : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    : unknown
  return (
    <div className="session-runtime" data-session-runtime={runtime.sessionKey}>
      <SettingsGroup data-testid="session-runtime-summary">
        <SettingsItem
          icon="bot"
          label={t('session.runtime.loopPlain')}
          description={loopLabel ?? loop?.id ?? unknown}
        />
        <SettingsItem icon="sparkles" label={t('session.runtime.model')} description={model ?? unknown} />
        <SettingsItem icon="shield" label={t('session.runtime.policy')} description={permission} />
        <SettingsItem
          icon="refresh-cw"
          label={t('session.runtime.version')}
          description={
            generation.newer
              ? t('session.runtime.versionOlder', { effect: t(effectKey(generation.newer.effect)) })
              : t(
                  generation.current || !generation.id
                    ? 'session.runtime.versionCurrent'
                    : 'session.runtime.versionHistorical',
                )
          }
        >
          {generation.newer ? <Tag tone="warn">{t('session.runtime.versionNewer')}</Tag> : undefined}
        </SettingsItem>
      </SettingsGroup>
      {runtime.restartRequired.length > 0 && (
        <p role="status">
          <Tag tone="bad">
            {t('session.runtime.restartRequired', { items: runtime.restartRequired.join(', ') })}
          </Tag>
        </p>
      )}
      {children}
      <SettingsTechnicalDetails data-testid="session-runtime-technical">
        <SettingsList>
          <ListRow
            title={t('session.runtime.generation')}
            description={generation.id ?? t('session.runtime.unpinned')}
            meta={generation.id ? <MetaText>{t('session.runtime.clientLive')}</MetaText> : undefined}
            status={
              generation.newer ? (
                <Tag tone="warn">
                  {t('session.runtime.newerGeneration', {
                    id: generation.newer.id,
                    effect: t(effectKey(generation.newer.effect)),
                  })}
                </Tag>
              ) : (
                <MetaText>
                  {t(generation.current ? 'session.runtime.current' : 'session.runtime.historical')}
                </MetaText>
              )
            }
          />
          <ListRow
            title={t('session.runtime.loop')}
            description={runtime.loop ? `${runtime.loop.id} ${runtime.loop.version}` : unknown}
            meta={
              runtime.preset ? (
                <MetaText>{t('session.runtime.preset', { name: runtime.preset.name })}</MetaText>
              ) : undefined
            }
          />
          <ListRow
            title={t('session.runtime.policy')}
            description={
              policy
                ? t('session.runtime.policyValue', {
                    mode: policy.approvalMode ?? t('session.runtime.unset'),
                    policy: policy.toolPolicy,
                    sandbox: policy.sandbox.provider,
                  })
                : unknown
            }
            status={policy ? undefined : unloaded}
          />
          {runtime.seams.map((seam) => (
            <ListRow
              key={`seam:${seam.kind}`}
              title={t('session.runtime.seam', { kind: seam.kind })}
              description={seam.provider}
              meta={seam.pinned ? <MetaText>{t('session.runtime.pinned')}</MetaText> : undefined}
              status={pendingTag(seam.pending)}
            />
          ))}
          {!runtime.loaded && (
            <ListRow title={t('session.runtime.providers')} description={unknown} status={unloaded} />
          )}
          {runtime.providers.map((provider) => (
            <ListRow
              key={`${provider.kind}:${provider.id}`}
              title={provider.kind}
              description={[provider.id, provider.version].filter(Boolean).join(' ')}
              status={pendingTag(provider.pending)}
            />
          ))}
          <ListRow
            title={t('session.runtime.resources')}
            description={
              !resources
                ? unknown
                : resources.items.length
                  ? resources.items.map((item) => `${item.id} ${item.revision ?? ''}`.trim()).join(' · ')
                  : t('session.runtime.none')
            }
            meta={resources?.modelRevision ? <MetaText>{resources.modelRevision}</MetaText> : undefined}
            status={resources ? undefined : unloaded}
          />
        </SettingsList>
      </SettingsTechnicalDetails>
    </div>
  )
}

/** One modal per page; each open reads a fresh descriptor from the daemon. */
export function createRuntimeDialog(options: {
  client: Client
  translate: Translate
  error(error: unknown): void
}) {
  const t = options.translate
  const host = createRegionHost(document.body, 'div')
  let runtime: SessionRuntimeDescriptor | undefined
  let tools: SessionToolsResult | undefined
  let toolsFailed = false
  let toolsBusy = false
  let grants: SessionGrants
  let revoking: string | undefined
  let loopLabels: Promise<Map<string, string>> | undefined
  let loopLabel: string | undefined
  let opened = false
  let version = 0
  let returnFocus: HTMLElement | undefined
  let sessionId: string | undefined
  const close = () => {
    opened = false
    version++
    render()
    const trigger = returnFocus?.isConnected
      ? returnFocus
      : Array.from(document.querySelectorAll<HTMLElement>('[data-session-action-id]')).find(
          (button) => button.dataset.sessionActionId === sessionId,
        )
    trigger?.focus()
  }
  function RuntimeDialog() {
    useDocumentLanguage()
    return (
      <dialog
        open={opened}
        hidden={!opened}
        role="presentation"
        className="react-dialog-host"
        data-agnes-region="dialog"
      >
        <Dialog
          open={opened}
          width={560}
          forceRender
          footer={null}
          onCancel={close}
          className="session-runtime-dialog"
          title={<h2 id="session-runtime-heading">{t('session.menu.runtime')}</h2>}
        >
          {runtime ? (
            <RuntimeInfo runtime={runtime} tools={tools} loopLabel={loopLabel} t={t}>
              <SessionGrantList grants={grants} revoking={revoking} onRevoke={revoke} t={t} />
              <SessionToolList
                tools={tools}
                failed={toolsFailed}
                busy={toolsBusy}
                onRefresh={() => void readTools(version)}
                t={t}
              />
            </RuntimeInfo>
          ) : (
            <p aria-busy="true">{t('session.runtime.loading')}</p>
          )}
          <div className="dialog-actions">
            <Button onClick={close}>{t('session.runtime.close')}</Button>
          </div>
        </Dialog>
      </dialog>
    )
  }
  const render = () => renderRegion(host, <RuntimeDialog />)
  /** Loop names come from the same public catalog the composer's picker reads; ids remain the fallback. */
  const readLoopLabels = () => {
    loopLabels ??= fetch('/admin/api/loops', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value: { loops?: unknown } | undefined) => {
        const labels = new Map<string, string>()
        for (const loop of Array.isArray(value?.loops) ? value.loops : []) {
          const { id, label } = (loop ?? {}) as { id?: unknown; label?: unknown }
          if (typeof id === 'string' && typeof label === 'string' && label) labels.set(id, label)
        }
        return labels
      })
      .catch(() => new Map<string, string>())
    return loopLabels
  }
  const readGrants = async (mine: number, id: string, value: SessionToolsResult) => {
    const next = await readSessionGrants(value.tools, (binding) =>
      options.client.approval.listGrants(id, binding),
    )
    if (mine !== version) return
    grants = next
    render()
  }
  /** Tools and remembered approvals need a live session; a session nobody has open reports neither. */
  const readTools = async (mine: number) => {
    const id = sessionId
    if (!id || toolsBusy) return
    toolsBusy = true
    toolsFailed = false
    render()
    try {
      const value = (await options.client.call('_agnes/v1/session.tools', {
        sessionId: id,
      })) as SessionToolsResult
      if (mine !== version) return
      tools = value
      void readGrants(mine, id, value)
    } catch {
      if (mine !== version) return
      toolsFailed = true
      grants = 'unavailable'
    } finally {
      if (mine === version) {
        toolsBusy = false
        render()
      }
    }
  }
  const revoke = (grant: ApprovalGrantRecord) => {
    const id = sessionId
    const mine = version
    if (!id || revoking) return
    revoking = grant.grantId
    render()
    void options.client.approval
      .revokeGrant(id, defaultGrantBinding(grant.toolId), grant.grantId)
      .then(() => (tools && mine === version ? readGrants(mine, id, tools) : undefined))
      .catch((failure: unknown) => {
        if (mine === version) options.error(failure)
      })
      .finally(() => {
        if (mine !== version) return
        revoking = undefined
        render()
      })
  }
  return {
    async open(id: string, trigger: HTMLElement) {
      const mine = ++version
      sessionId = id
      returnFocus = trigger
      runtime = undefined
      tools = undefined
      toolsFailed = false
      toolsBusy = false
      grants = undefined
      revoking = undefined
      loopLabel = undefined
      opened = true
      render()
      try {
        const value = await options.client.session.runtime(id)
        if (mine !== version) return
        runtime = value
        render()
        void readTools(mine)
        const loop = value.loop?.id
        if (loop)
          void readLoopLabels().then((labels) => {
            if (mine !== version) return
            loopLabel = labels.get(loop)
            render()
          })
      } catch (failure) {
        if (mine !== version) return
        close()
        options.error(failure)
      }
    },
    dispose() {
      unmountRegion(host)
      host.remove()
    },
  }
}
