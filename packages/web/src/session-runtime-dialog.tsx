import type { SessionRuntimeDescriptor } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { Translate } from '@agnes/web-conversation/presentation'
import {
  Button,
  createRegionHost,
  Dialog,
  ListRow,
  MetaText,
  renderRegion,
  Tag,
  unmountRegion,
} from '@agnes/web-ui'

type Pending = NonNullable<SessionRuntimeDescriptor['providers'][number]['pending']>
const effectKey = (effect: Pending['effect']) =>
  effect === 'restart-required' ? 'session.runtime.effect.restart' : 'session.runtime.effect.newSessions'

/** Description-only view of the Host's runtime descriptor; nothing is derived here. */
export function RuntimeInfo({ runtime, t }: { runtime: SessionRuntimeDescriptor; t: Translate }) {
  const { generation, policy, resources } = runtime
  const pendingTag = (pending: Pending | undefined) =>
    pending ? (
      <Tag tone="warn">
        {t('session.runtime.pending', { target: pending.id, effect: t(effectKey(pending.effect)) })}
      </Tag>
    ) : undefined
  return (
    <div className="agnes-settings-stack" data-session-runtime={runtime.sessionKey}>
      <ListRow
        title={t('session.runtime.generation')}
        description={generation.id ?? t('session.runtime.unpinned')}
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
        description={`${runtime.loop.id} ${runtime.loop.version}`}
        meta={<MetaText>{t('session.runtime.preset', { name: runtime.preset.name })}</MetaText>}
      />
      {runtime.providers.map((provider) => (
        <ListRow
          key={`${provider.kind}:${provider.id}`}
          title={provider.kind}
          description={[provider.id, provider.version].filter(Boolean).join(' ')}
          status={pendingTag(provider.pending)}
        />
      ))}
      {runtime.seams.map((seam) => (
        <ListRow
          key={`seam:${seam.kind}`}
          title={t('session.runtime.seam', { kind: seam.kind })}
          description={seam.provider}
          meta={seam.pinned ? <MetaText>{t('session.runtime.pinned')}</MetaText> : undefined}
          status={pendingTag(seam.pending)}
        />
      ))}
      <ListRow
        title={t('session.runtime.policy')}
        description={t('session.runtime.policyValue', {
          mode: policy.approvalMode ?? t('session.runtime.unset'),
          policy: policy.toolPolicy,
          sandbox: policy.sandbox.provider,
        })}
      />
      <ListRow
        title={t('session.runtime.resources')}
        description={
          resources.items.length
            ? resources.items.map((item) => `${item.id} ${item.revision ?? ''}`.trim()).join(' · ')
            : t('session.runtime.none')
        }
        meta={resources.modelRevision ? <MetaText>{resources.modelRevision}</MetaText> : undefined}
      />
      {runtime.restartRequired.length > 0 && (
        <p role="status">
          <Tag tone="bad">
            {t('session.runtime.restartRequired', { items: runtime.restartRequired.join(', ') })}
          </Tag>
        </p>
      )}
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
  let opened = false
  let version = 0
  let returnFocus: HTMLElement | undefined
  const close = () => {
    opened = false
    version++
    render()
    if (returnFocus?.isConnected) returnFocus.focus()
  }
  const render = () =>
    renderRegion(
      host,
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
            <RuntimeInfo runtime={runtime} t={t} />
          ) : (
            <p aria-busy="true">{t('session.runtime.loading')}</p>
          )}
          <div className="dialog-actions">
            <Button onClick={close}>{t('session.runtime.close')}</Button>
          </div>
        </Dialog>
      </dialog>,
    )
  return {
    async open(id: string, trigger: HTMLElement) {
      const mine = ++version
      returnFocus = trigger
      runtime = undefined
      opened = true
      render()
      try {
        const value = await options.client.session.runtime(id)
        if (mine !== version) return
        runtime = value
        render()
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
