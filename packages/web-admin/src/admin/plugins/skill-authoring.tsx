import { registerSkillPagePanels } from '@agnes/resource-control-web/admin'
import { Button, Dialog, SettingsState, hasPermission, useUiText } from '@agnes/web-ui'
import { type ComponentProps, useEffect, useState } from 'react'
import { FeedbackAdminPanel } from '../../settings/feedback.js'
import { PluginAdminApi } from './api.js'
import { CandidateInbox } from './candidates.js'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'
import type { AdminContext } from './types.js'

type Confirmation = Parameters<ComponentProps<typeof CandidateInbox>['confirm']>[0]
function SkillCandidatePanel({
  onPendingCount,
  onPublished,
}: {
  onPendingCount(count: number): void
  onPublished(): Promise<void>
}) {
  const { t } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const [context, setContext] = useState<AdminContext>()
  const [api, setApi] = useState<PluginAdminApi>()
  const [pending, setPending] = useState<Confirmation>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    void revision
    let alive = true
    setFailed(false)
    void PluginAdminApi.context()
      .then((value) => {
        if (!alive) return
        setContext(value)
        setApi(new PluginAdminApi(value))
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [revision])
  const writable = context && !context.readOnly
  return (
    <>
      {failed && (
        <SettingsState tone="error">
          {t('candidates.unavailable')}
          <Button onClick={() => setRevision((value) => value + 1)}>{t('candidates.refresh')}</Button>
        </SettingsState>
      )}
      <CandidateInbox
        api={api}
        canReview={
          !!writable &&
          ['packages.trust', 'packages.install', 'packages.activate'].every((permission) =>
            hasPermission(context.permissions, permission),
          )
        }
        canTest={!!writable && hasPermission(context.permissions, 'extensions.execute')}
        t={t}
        confirm={setPending}
        onPublished={onPublished}
        scope="skill"
        onPendingCount={onPendingCount}
      />
      <Dialog
        open={!!pending}
        title={pending?.title}
        footer={null}
        onCancel={() => {
          if (!busy) setPending(undefined)
        }}
        closable={!busy}
        maskClosable={!busy}
      >
        <p>{pending?.description}</p>
        {pending?.facts}
        <div className="agh-dialog-footer">
          <Button disabled={busy} onClick={() => setPending(undefined)}>
            {t('shell.cancel')}
          </Button>
          <Button
            appearance="primary"
            loading={busy}
            onClick={() => {
              if (!pending || busy) return
              setBusy(true)
              void pending
                .run()
                .then(() => setPending(undefined))
                .catch(() => setFailed(true))
                .finally(() => setBusy(false))
            }}
          >
            {pending?.label}
          </Button>
        </div>
      </Dialog>
    </>
  )
}
/** Skills can be the first settings page opened; authoring does not depend on mounting Plugins. */
export function mountSkillAuthoring(onPublished: () => Promise<void>) {
  return registerSkillPagePanels({
    review: (onPendingCount) => (
      <SkillCandidatePanel onPendingCount={onPendingCount} onPublished={onPublished} />
    ),
    feedback: <FeedbackAdminPanel />,
  })
}
