import {
  type ApplicationPreview,
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  resolvePluginMetadata,
} from '@agnes/protocol'
import { applicationIdentity, homeNavigation, resolveApplicationBrand } from '@agnes/web-client'
import {
  Banner,
  Button,
  Disclosure,
  Loadable,
  PluginPrimaryStatus,
  PushPage,
  SettingsItem,
  usePushStack,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { InstallReview, shortSource } from '../admin/plugins/install-review.js'
import { ApplicationPreviewSummary } from '../settings/application-preview.js'
import { AGENTS_NAMESPACE, agentsCatalog } from './agents-locale.js'
import type { BusinessAgentsData } from './gallery.js'
import { startGets } from './start-dialog.js'
import {
  planBlocked,
  planBusinessAgentStart,
  runBusinessPackageInstall,
  type StartPlan,
} from './start-flow.js'

/** Only bounded raster discovery bytes, never URLs or executable catalogue content. */
function ApplicationMark({ data }: { data?: string | undefined }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!data || data.length > 174800) return
    const match = /^data:(image\/(?:png|jpeg|webp|gif|x-icon));base64,([A-Za-z0-9+/=]+)$/.exec(data)
    if (!match?.[1] || !match[2]) return
    let next: string
    try {
      const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
      next = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
    } catch {
      return
    }
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
      setUrl(undefined)
    }
  }, [data])
  return url ? (
    <img src={url} alt="" width={64} height={64} onError={() => setUrl(undefined)} />
  ) : (
    <span className="agnes-mark" aria-hidden="true" />
  )
}

type Review = { preview: ApplicationPreview; revision: number }
/** One package-level application journey. Every consented mutation uses the existing backend contract. */
export function ApplicationCard({
  entry,
  data,
  onStartAgent,
  startableAgents,
}: {
  entry: PackageCatalogDescriptor | PackageInstalledDescriptor
  data: BusinessAgentsData
  onStartAgent?: ((ref: string) => void) | undefined
  startableAgents?: readonly string[] | undefined
}) {
  const { t, locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const tr = (en: string, zh: string) => (locale === 'zh-CN' ? zh : en)
  const brand = resolveApplicationBrand(entry.application, locale)
  const metadata = resolvePluginMetadata(entry.metadata, locale)
  const application = useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const adopted = application?.status === 'active' && application.selection?.packageId === entry.id
  const installed = data.installed.find((row) => row.id === entry.id)
  const nav = usePushStack()
  const pageId = `application-${encodeURIComponent(entry.id)}`
  const [plan, setPlan] = useState<StartPlan>()
  const [review, setReview] = useState<Review>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController>()
  useEffect(() => () => controller.current?.abort(), [])
  const ready = installed?.trusted && installed.desired === 'enabled' && installed.actual === 'running'
  const denied = data.adoptionDenied ?? (!ready ? data.denied : undefined)
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busy || !data.api || denied) return
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setBusy(true)
    setError('')
    try {
      await action(next.signal)
    } catch (e) {
      if (!next.signal.aborted) setError(e instanceof Error ? e.message : t('reason.request'))
    } finally {
      if (!next.signal.aborted) {
        setBusy(false)
        data.refreshInstalled()
      }
    }
  }
  const preview = async (signal: AbortSignal) => {
    const api = data.api!
    // Read revision before preview; later configuration changes are refused by adoption CAS.
    const state = await api.application()
    const value = await api.previewApplication(entry.id)
    signal.throwIfAborted()
    setPlan(undefined)
    setReview({ preview: value, revision: state.revision })
  }
  const begin = () => {
    nav.open(pageId)
    setReview(undefined)
    setPlan(undefined)
    void run(async (signal) => {
      const next = await planBusinessAgentStart(data.api!, entry, { signal })
      signal.throwIfAborted()
      if (!planBlocked(next) && !next.needed.install && !next.needed.trust && !next.needed.enable)
        await preview(signal)
      else setPlan(next)
    })
  }
  const reviewed = plan?.preview ?? plan?.installed
  return (
    <>
      <article className="agent-card application-card" data-application={entry.id}>
        <header>
          <ApplicationMark data={'applicationAssets' in entry ? entry.applicationAssets?.mark : undefined} />
          <div className="agent-card-heading">
            <p className="application-eyebrow">{tr('Industry application', '行业应用')}</p>
            <h3>{brand.title}</h3>
          </div>
        </header>
        <p className="agent-card-summary">{metadata?.summary}</p>
        <div className="application-preview">
          <p>{metadata?.description}</p>
          <span>
            {tr(
              'Branded workspace · Industry dashboard · Evidence and review',
              '专属品牌工作台 · 行业看板 · 证据与审核',
            )}
          </span>
        </div>
        {entry.application?.workbench?.scenarios && (
          <ul className="application-scenarios">
            {entry.application.workbench.scenarios.map((scenario) => (
              <li key={scenario.en}>{scenario[locale] ?? scenario.en}</li>
            ))}
          </ul>
        )}
        {!!entry.application?.workbench?.includes?.length && (
          <p className="application-includes">
            {tr('Includes: ', '包含：')}
            {entry.application.workbench.includes
              .map(
                (feature) =>
                  ({
                    pages: tr('business pages', '业务页面'),
                    tools: tr('business tools', '业务工具'),
                    signatures: tr('signatures', '签署流程'),
                    reports: tr('automated reports', '自动报告'),
                  })[feature],
              )
              .join(' · ')}
          </p>
        )}
        {installed && <PluginPrimaryStatus status={installed.primaryStatus} />}
        {!!entry.agents?.length && (
          <Disclosure
            variant="plain"
            className="application-roles"
            summary={tr(
              `${entry.agents?.length ?? 0} role agents`,
              `${entry.agents?.length ?? 0} 个角色智能体`,
            )}
          >
            <ul>
              {entry.agents?.map((agent) => (
                <li key={agent.ref}>
                  <strong>{agent.launch.title[locale] ?? agent.launch.title.en}</strong>
                  <p>{agent.launch.description[locale] ?? agent.launch.description.en}</p>
                  {!entry.application?.workbench &&
                    ready &&
                    onStartAgent &&
                    (!startableAgents || startableAgents.includes(agent.ref)) && (
                      <Button onClick={() => onStartAgent(agent.ref)}>{t('start')}</Button>
                    )}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {adopted &&
          entry.application?.workbench &&
          ready &&
          onStartAgent &&
          entry.application.defaultAgent &&
          (!startableAgents || startableAgents.includes(entry.application.defaultAgent)) && (
            <Button onClick={() => onStartAgent(entry.application!.defaultAgent!)}>
              {tr('Open workbench assistant', '打开工作台助手')}
            </Button>
          )}
        {denied && <Banner tone="warning">{t(denied)}</Banner>}
        <footer>
          <Button
            appearance="primary"
            disabled={adopted ? false : !!denied || !data.api}
            {...(denied ? { disabledReason: t(denied) } : {})}
            onClick={adopted ? () => homeNavigation.close() : begin}
          >
            {adopted
              ? tr('Open', '打开')
              : installed
                ? tr('Adopt', '采用')
                : tr('Install and adopt', '安装并采用')}
          </Button>
        </footer>
      </article>
      <PushPage id={pageId} title={brand.title}>
        <Loadable loading={busy} hasData={!!plan || !!review} />
        {error && <Banner tone="error">{error}</Banner>}
        {plan && reviewed && (
          <InstallReview
            name={brand.title}
            meta={[entry.version]}
            source={shortSource(entry.source)}
            verified={undefined}
            lead={tr(
              'Review installation, trust and enablement before adopting this application.',
              '先审阅安装、信任与启用，再预览并采用应用。',
            )}
            gets={
              <>
                {startGets(reviewed, t).map((row) => (
                  <SettingsItem key={row.title} icon={row.icon} label={row.title} description={row.detail} />
                ))}
              </>
            }
            technical={<pre>{JSON.stringify(reviewed, null, 2)}</pre>}
            notices={
              planBlocked(plan) ? (
                <Banner tone="error">{JSON.stringify(reviewed.blockers)}</Banner>
              ) : undefined
            }
            actions={
              <Button
                appearance="primary"
                disabled={busy || !!denied || planBlocked(plan)}
                onClick={() =>
                  void run(async (signal) => {
                    await runBusinessPackageInstall(data.api!, plan, () => {}, {
                      signal,
                      features: data.features,
                    })
                    await preview(signal)
                  })
                }
              >
                {tr('Install, trust and enable', '安装、信任并启用')}
              </Button>
            }
          />
        )}
        {review && (
          <section aria-label={tr('Application consent preview', '应用采用预览')}>
            <h3>{tr('Review application', '审阅应用')}</h3>
            <ApplicationPreviewSummary preview={review.preview} description={metadata?.summary} application />
            <p className="agnes-settings-note">
              {tr(
                'You can switch applications again from the sidebar.',
                '可随时通过侧栏的“切换应用”回到设置。',
              )}
            </p>
            <div className="home-push-actions">
              <Button disabled={busy} onClick={() => nav.back()}>
                {t('dialog.cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={busy || !!denied}
                onClick={() =>
                  void run(async (signal) => {
                    const state = await data.api!.adoptApplication(
                      entry.id,
                      review.revision,
                      review.preview.consentDigest,
                    )
                    signal.throwIfAborted()
                    if (state.status !== 'active' || state.selection?.packageId !== entry.id)
                      throw new Error(
                        tr('Application unavailable; preview again.', '应用不可用，请重新预览。'),
                      )
                    // A fresh bootstrap applies the new brand, skin, navigation and declared home together.
                    location.assign('/')
                  })
                }
              >
                {tr('Adopt', '采用')}
              </Button>
            </div>
          </section>
        )}
        {!busy && error && (
          <Button onClick={begin}>{tr('Refresh and review again', '刷新并重新审阅')}</Button>
        )}
        {!review && (
          <Button
            disabled={busy}
            onClick={() => {
              controller.current?.abort()
              nav.back()
            }}
          >
            {t('dialog.cancel')}
          </Button>
        )}
      </PushPage>
    </>
  )
}
