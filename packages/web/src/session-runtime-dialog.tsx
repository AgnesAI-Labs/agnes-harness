import type { SessionApprovalGrant, SessionRuntimeDescriptor, SessionToolsResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { SessionSchedules } from '@agnes/web-admin/settings/schedules'
import { homeNavigation } from '@agnes/web-client'
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
import { SessionHeadsUp } from './heads-up-view.js'
import {
  grantsFailure,
  orderGrants,
  SessionGrantList,
  type SessionGrants,
  SessionToolList,
} from './session-runtime-sections.js'

type Pending = NonNullable<SessionRuntimeDescriptor['providers'][number]['pending']>
const effectKey = (effect: Pending['effect']) =>
  effect === 'restart-required' ? 'session.runtime.effect.restart' : 'session.runtime.effect.newSessions'

/** What else the session's capability snapshot lists; tools have their own section above. */
const CAPABILITY_KINDS = [
  'mcp',
  'skills',
  'modelAdapters',
  'childEngines',
  'childModels',
  'uiModules',
  'surfaces',
  'packages',
  'plugins',
] as const

/** Permission levels; a session from an older Host names its level as its preset. */
const PERMISSION_KEYS: Record<string, string> = {
  'read-only': 'session.runtime.permission.view',
  'workspace-write': 'session.runtime.permission.workspace',
  'full-access': 'session.runtime.permission.full',
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
  permission: level,
  children,
  t,
}: {
  runtime: SessionRuntimeDescriptor
  tools?: SessionToolsResult | undefined
  loopLabel?: string | undefined
  /** The permission level the session list reports for this session. */
  permission?: string | undefined
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
  const effectiveLevel = policy?.permission ? policy.permission.policy || 'workspace-write' : level
  const levelId =
    effectiveLevel && PERMISSION_KEYS[effectiveLevel]
      ? effectiveLevel
      : preset && PERMISSION_KEYS[preset]
        ? preset
        : undefined
  const readOnly = capabilities?.permissions.readOnly ?? policy?.readOnly
  const permission =
    levelId || preset
      ? [
          levelId
            ? t(PERMISSION_KEYS[levelId] as string)
            : t('session.runtime.permission.preset', { name: preset ?? '' }),
          readOnly && levelId !== 'read-only' ? t('session.runtime.permission.view') : undefined,
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
        <SettingsItem
          icon="shield"
          label={t('session.runtime.policy')}
          description={[permission, policy?.permission?.principal].filter(Boolean).join(' · ')}
        />
        {policy?.sandbox.provider === 'local' &&
          policy.sandbox.enforcement &&
          policy.sandbox.enforcement.level !== 'full' &&
          !policy.sandbox.enforcement.scope.includes('process') && (
            <SettingsItem
              icon="shield"
              label={t('session.runtime.noOsIsolation')}
              description={t('session.runtime.noOsIsolationHelp')}
            />
          )}
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
          {CAPABILITY_KINDS.map((kind) => {
            const items = capabilities?.[kind] ?? []
            const off = items.filter((item) => !item.enabled).length
            return items.length ? (
              <ListRow
                key={`capability:${kind}`}
                data-testid={`session-runtime-capability-${kind}`}
                title={t(`session.runtime.capability.${kind}`, { count: items.length })}
                description={items.map((item) => item.id).join(' · ')}
                meta={
                  off ? <MetaText>{t('session.runtime.capabilityOff', { count: off })}</MetaText> : undefined
                }
              />
            ) : undefined
          })}
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
  /** The display name of a loop, when the host knows one. */
  loopLabel?: ((id: string) => string | undefined) | undefined
  /** The permission level the session list reports for a session. */
  permissionOf?: ((id: string) => string | undefined) | undefined
}) {
  const t = options.translate
  const host = createRegionHost(document.body, 'div')
  let integrity: import('@agnes/protocol').SessionIntegrityStatus | undefined
  let auditing = false
  let integrityRead = 0
  let integrityTimer: ReturnType<typeof setTimeout> | undefined
  let runtime: SessionRuntimeDescriptor | undefined
  let tools: SessionToolsResult | undefined
  let toolsFailed = false
  let toolsBusy = false
  let grants: SessionGrants
  let revoking: string | undefined
  let loopLabel: string | undefined
  let opened = false
  let version = 0
  let returnFocus: HTMLElement | undefined
  let sessionId: string | undefined
  const close = () => {
    opened = false
    clearTimeout(integrityTimer)
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
            <RuntimeInfo
              runtime={runtime}
              tools={tools}
              loopLabel={loopLabel}
              permission={sessionId ? options.permissionOf?.(sessionId) : undefined}
              t={t}
            >
              <SettingsGroup title={t('session.integrity.title')}>
                <p role="status" aria-live="polite" aria-busy={auditing || integrity?.state === 'verifying'}>
                  {t(
                    auditing || integrity?.state === 'verifying'
                      ? 'session.integrity.verifying'
                      : integrity?.state === 'verified'
                        ? 'session.integrity.verified'
                        : integrity?.state === 'failed'
                          ? integrity.failureSeq === undefined
                            ? 'session.integrity.failedUnknown'
                            : 'session.integrity.failed'
                          : 'session.integrity.unknown',
                    {
                      seq: integrity?.failureSeq ?? integrity?.verifiedThroughSeq ?? 0,
                      time: integrity?.verifiedAtMs ? new Date(integrity.verifiedAtMs).toLocaleString() : '',
                    },
                  )}
                </p>
                {integrity && integrity.legacyThroughSeq > 0 && (
                  <MetaText>{t('session.integrity.legacy', { seq: integrity.legacyThroughSeq })}</MetaText>
                )}
                <Button disabled={auditing} onClick={() => void readIntegrity(version, true)}>
                  {t('session.integrity.verify')}
                </Button>
              </SettingsGroup>
              <SessionGrantList
                grants={grants}
                revoking={revoking}
                onRevoke={revoke}
                onRetry={retryGrants}
                t={t}
              />
              {sessionId && <SessionHeadsUp sessionId={sessionId} t={t} />}
              <SessionToolList
                tools={tools}
                failed={toolsFailed}
                busy={toolsBusy}
                onRefresh={() => void readTools(version)}
                t={t}
              />
              {sessionId && (
                <SessionSchedules
                  list={listSchedules}
                  sessionKey={sessionId}
                  onManage={() => {
                    close()
                    homeNavigation.open('automation', { tab: 'schedules' })
                  }}
                />
              )}
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
  const listSchedules = (params: { scope: 'session'; sessionKey: string }) =>
    options.client.call('_agnes/v1/schedules.list', params)
  /**
   * The daemon lists what this session may do without asking. A failed read stays visible and says
   * whether it was refused or failed, so it is never mistaken for «nothing is allowed».
   */
  const readGrants = async (mine: number, id: string, retries = 0) => {
    let next: SessionGrants
    try {
      next = orderGrants((await options.client.approval.sessionGrants(id)).grants)
    } catch (failure) {
      next = { failed: grantsFailure(failure), retries }
    }
    if (mine !== version) return
    grants = next
    render()
  }
  /** Tools need a live session; a session nobody has open reports none. */
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
    } catch {
      if (mine !== version) return
      toolsFailed = true
    } finally {
      if (mine === version) {
        toolsBusy = false
        render()
      }
    }
  }
  const retryGrants = () => {
    const id = sessionId
    const previous = grants
    if (!id || !previous || !('failed' in previous)) return
    grants = undefined
    render()
    void readGrants(version, id, previous.retries + 1)
  }
  const revoke = (grant: SessionApprovalGrant) => {
    const id = sessionId
    const mine = version
    if (!id || revoking) return
    revoking = grant.grantId
    render()
    void options.client.approval
      .revokeSessionGrant(id, grant.grantId)
      .then(() => (mine === version ? readGrants(mine, id) : undefined))
      .catch((failure: unknown) => {
        if (mine === version) options.error(failure)
      })
      .finally(() => {
        if (mine !== version) return
        revoking = undefined
        render()
      })
  }
  const readIntegrity = async (mine: number, verify = false) => {
    if (!sessionId || mine !== version || !opened) return
    const read = ++integrityRead
    const current = () => mine === version && read === integrityRead
    clearTimeout(integrityTimer)
    if (verify) {
      auditing = true
      render()
    }
    try {
      const result = await options.client.session.integrity(sessionId, verify)
      if (!current()) return
      integrity = result
      if (result.state === 'verifying') integrityTimer = setTimeout(() => void readIntegrity(mine), 1000)
    } catch (failure) {
      if (current()) {
        integrity = undefined
        options.error(failure)
      }
    } finally {
      if (current()) {
        auditing = false
        render()
      }
    }
  }
  const open = async (id: string, trigger: HTMLElement) => {
    const mine = ++version
    sessionId = id
    returnFocus = trigger
    runtime = undefined
    integrity = undefined
    auditing = false
    clearTimeout(integrityTimer)
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
      // The composer's catalog names loops; an id it does not know is shown as it is.
      loopLabel = value.loop ? options.loopLabel?.(value.loop.id) : undefined
      render()
      if (value.loaded) void readIntegrity(mine)
      void readTools(mine)
      void readGrants(mine, id)
    } catch (failure) {
      if (mine !== version) return
      close()
      options.error(failure)
    }
  }
  return {
    open,
    /** An invalidation only identifies what to re-read; it never supplies runtime authority. */
    invalidate(id: string) {
      if (opened && sessionId === id && returnFocus) return open(id, returnFocus)
    },
    dispose() {
      clearTimeout(integrityTimer)
      opened = false
      version++
      unmountRegion(host)
      host.remove()
    },
  }
}
