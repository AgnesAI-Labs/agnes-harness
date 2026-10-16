import type { PackageSource } from '@agnes/protocol'
import {
  ADMIN_LOCALE_NAMESPACE,
  adminLocaleCatalog,
  Banner,
  Button,
  blockerText,
  type IconName,
  IconTile,
  SettingsGroup,
  SettingsItem,
  SettingsTechnicalDetails,
  UpdateDiff,
  useUiText,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { PreviewTechnicalFacts } from './admin/confirms.js'
import { capabilityRequests } from './capability-review.js'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'
import type { InstallReviewState } from './types.js'

/**
 * The one page that asks before a package is installed: the plugins marketplace, 添加插件 and a
 * business agent's one-click start all show it. Only what the reader judges is up front (what it
 * gets, whether its source is verified); hashes, paths and the full record sit under 技术详情,
 * collapsed, where long values wrap instead of running off the page.
 */
export function InstallReview({
  testId = 'install-review',
  getsTestId = 'install-review-gets',
  icon = 'puzzle',
  name,
  meta,
  lead,
  before,
  gets,
  getsNote,
  verified,
  source,
  notices,
  technical,
  error,
  retryLabel,
  onRetry,
  actions,
}: {
  testId?: string
  getsTestId?: string
  icon?: IconName
  name: ReactNode
  /** Kind, version and source tier, shown under the name. */
  meta: readonly (string | undefined)[]
  lead?: ReactNode
  /** Sections the reader judges first, such as what an update changes. */
  before?: ReactNode
  /** Rows of 「它会获得什么」; the sandbox and network row is always added after them. */
  gets: ReactNode
  getsNote?: ReactNode
  /** Whether the publisher evidence was verified; undefined when nothing was reported. */
  verified: boolean | undefined
  /** A short name for where it comes from, never an absolute path. */
  source: string
  notices?: ReactNode
  technical: ReactNode
  /** Why the last attempt stopped, with its retry beside it. */
  error?: ReactNode
  retryLabel?: string
  onRetry?: () => void
  actions: ReactNode
}) {
  const { t } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  return (
    <div className="install-review" data-testid={testId}>
      <div className="install-review-hero">
        <IconTile name={icon} />
        <div>
          <strong className="install-review-name">{name}</strong>
          <p className="install-review-meta" data-testid="install-review-meta">
            {meta.filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      {lead && <p className="install-review-lead">{lead}</p>}
      {before}
      <section aria-labelledby={`${testId}-gets`}>
        <h3 id={`${testId}-gets`}>{t('capability.title')}</h3>
        <SettingsGroup data-testid={getsTestId}>
          {gets}
          <SettingsItem
            icon="shield-check"
            label={t('review.policy')}
            description={t('review.policy.current')}
          />
        </SettingsGroup>
        {getsNote && <p className="install-review-note">{getsNote}</p>}
      </section>
      <section aria-labelledby={`${testId}-source`}>
        <h3 id={`${testId}-source`}>{t('review.source')}</h3>
        {verified !== true && (
          <Banner tone="warning" data-testid="install-review-unverified">
            {t('provenance.unverified')}
          </Banner>
        )}
        <SettingsGroup data-testid="install-review-source">
          <SettingsItem
            icon={verified ? 'shield-check' : 'folder-open'}
            label={t('review.source')}
            description={source}
          />
        </SettingsGroup>
      </section>
      {notices}
      <SettingsTechnicalDetails data-testid="install-review-technical" className="install-review-technical">
        {technical}
      </SettingsTechnicalDetails>
      {error && (
        <p className="install-review-error" role="alert" data-testid="install-review-error">
          <span>{error}</span>
          {onRetry && (
            <Button appearance="link" data-testid="install-review-retry" onClick={onRetry}>
              {retryLabel ?? t('review.retry')}
            </Button>
          )}
        </p>
      )}
      <div className="home-push-actions install-review-bar">{actions}</div>
    </div>
  )
}

const LOCAL_SOURCES = new Set(['file', 'local', 'workspace', 'path'])

/** The last part of a folder or archive path, so the review never shows an absolute local path. */
export function shortSource(source: PackageSource): string {
  if (!LOCAL_SOURCES.has(source.type)) return source.ref
  const path = source.ref.replace(/^[a-z]+:/i, '').replace(/[\\/]+$/, '')
  return path.split(/[\\/]/).at(-1) || source.ref
}

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/**
 * The review of a finished plugin check, for an install or an update. Every fact and choice the
 * confirmation used to show is here; only their grouping changed.
 */
export function PluginInstallReview({
  review,
  name,
  kind,
  tier,
  t,
  onCancel,
  onConfirm,
}: {
  review: InstallReviewState
  name: string
  /** The package's kind in words, such as 执行方式（Agent Loop）. */
  kind: string | undefined
  /** Where it ranks as a source, such as 官方示例. */
  tier: string | undefined
  t: Text
  onCancel(): void
  onConfirm(enableAfter: boolean): void
}) {
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  const { preview, mode, current, combined, enables, enableAfter, busy, error } = review
  const describe = mode === 'install' ? mode : combined ? 'update-combined' : 'update-compatible'
  const action = combined
    ? 'update-activate'
    : enables
      ? 'install-enable'
      : mode === 'install'
        ? 'install'
        : 'update'
  const requests = capabilityRequests(preview.declaredCapabilities, t)
  const blocked = preview.blockers.length > 0
  return (
    <InstallReview
      name={name}
      meta={[kind, preview.version, tier]}
      lead={t(`preview.description.${describe}`)}
      before={current ? <UpdateDiff preview={preview} fromVersion={current.version} /> : undefined}
      gets={
        <SettingsItem
          icon="key-round"
          label={t('review.capabilities')}
          description={
            requests.length
              ? requests.join(t('review.separator'))
              : t(preview.declaredCapabilities === undefined ? 'review.undeclared' : 'capability.none')
          }
        />
      }
      getsNote={t('capability.community')}
      verified={preview.provenance.signatureVerified}
      source={[tier, shortSource(preview.source)].filter(Boolean).join(' · ')}
      notices={
        <>
          {blocked && (
            <Banner tone="error" data-testid="install-review-blocked">
              {preview.blockers.map((blocker) => blockerText(blocker, adminText)).join(t('review.separator'))}
            </Banner>
          )}
          {preview.warnings.length > 0 && (
            <Banner tone="warning" data-testid="install-review-warnings">
              {preview.warnings.map((warning) => warning.safeMessage).join(t('review.separator'))}
            </Banner>
          )}
        </>
      }
      technical={<PreviewTechnicalFacts preview={preview} current={current} combined={combined} t={t} />}
      error={error ? (error.message ? error.message : t('error.operation-failed')) : undefined}
      {...(error ? { onRetry: () => onConfirm(enableAfter) } : {})}
      actions={
        <>
          <Button data-testid="install-review-cancel" disabled={busy} onClick={onCancel}>
            {t('review.cancel')}
          </Button>
          {enables && (
            <Button data-testid="install-review-secondary" disabled={busy} onClick={() => onConfirm(false)}>
              {t('preview.action.install-only')}
            </Button>
          )}
          <Button
            appearance="primary"
            data-testid="install-review-confirm"
            loading={busy}
            disabled={busy}
            onClick={() => onConfirm(enables)}
          >
            {t(`preview.action.${action}`)}
          </Button>
        </>
      }
    />
  )
}

export { ExampleManagementNotice } from './admin/example-parent.js'
