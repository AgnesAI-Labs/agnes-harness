import { type PackageSource, resolvePluginMetadata } from '@agnes/protocol'
import {
  Button,
  blockerText,
  ConfirmDialogContent,
  Count,
  contributionText,
  DetailContent,
  Field,
  Icon,
  integrityLabel,
  Menu,
  OrphanPins,
  operationLabel,
  PLUGIN_CATEGORIES,
  PluginList,
  PluginPurposeSections,
  Popover,
  renderRegion,
  SettingsDetails,
  SettingsInput,
  SettingsPageHeader,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
  SourceDialogContent,
  sourceLabel,
  Tabs,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { OfficialExampleCards } from '../../../settings/examples.js'
import { SettingsHub } from '../../../settings/hub.js'
import { sessionStartUrl } from '../../../settings/runtime-panels.js'
import { CandidateInbox } from '../candidates.js'
import { CapabilityReview, FailureHelp, ProvenanceReview } from '../capability-review.js'
import { PluginConfigTab } from '../config-tab.js'
import { GenerationDrainSummary, KindFilter, PluginBadges, pluginFailureMessage } from '../control-panel.js'
import { PluginDetailCopy } from '../detail-copy.js'
import { PluginOperationFeedback } from '../operation-feedback.js'
import { SOURCE_FORMATS, sourceProblem } from '../source-form.js'
import { setDialog } from './dom.js'
import { asRuntimeView, pinPurposeLabel } from './model.js'
import type { PluginAdminViewContext } from './page.js'

const SOURCE_TYPE_OPTIONS = Object.keys(SOURCE_FORMATS)
  .filter((type) => type !== 'local')
  .map((type) => ({
    value: type,
    label: type,
  }))

export function renderPluginView(this: PluginAdminViewContext): void {
  const { context, connection, error, loading, tree } = this.state
  // 通知条/树状态/恢复横幅是骨架上的单行文本节点，命令式赋值即可；真正的手工业（列表行、
  // 详情体、对话框内容）全部在下面的 React 区域里。
  this.recovery.hidden = !context?.readOnly
  this.layout.dataset.detail = String(this.hasDetail())
  const connectionNotice =
    connection === 'loading'
      ? this.t('connection.loading')
      : connection === 'offline'
        ? this.t('connection.offline')
        : connection === 'forbidden'
          ? this.t('connection.forbidden')
          : ''
  const noticeMessage = error
    ? this.state.lastOperation
      ? this.t('notice.operation-error', {
          operation: operationLabel(this.state.lastOperation, this.adminT),
          message: this.errorMessage(error),
        })
      : this.errorMessage(error)
    : this.state.loading
      ? this.t('connection.loading')
      : this.state.lastOperation
        ? this.t('notice.operation-refreshed', {
            operation: operationLabel(this.state.lastOperation, this.adminT),
          })
        : this.noticeText() || connectionNotice
  const noticeKind = error ? 'error' : connection === 'connected' ? this.noticeState.kind : 'state'
  this.notice.textContent = noticeMessage
  this.notice.dataset.kind = noticeKind
  const treeText =
    tree?.desiredDigest && !tree.actual
      ? tree.failurePhase && !tree.pending
        ? this.t('tree.error')
        : this.t('tree.loading')
      : ''
  this.treeStatus.textContent = treeText
  this.treeStatus.hidden = !treeText
  this.orphanPinsHost.hidden = this.orphanPinList.length === 0 && !this.orphanPinFetchError
  renderRegion(
    this.orphanPinsHost,
    <UiLocaleProvider source={this.locale}>
      <OrphanPins
        pins={this.orphanPinList.map((pin) => ({
          pinId: pin.pinId,
          packageId: pin.packageId,
          version: pin.version,
          purpose: pinPurposeLabel(pin.purpose, this.t),
          snapshotId: integrityLabel(pin.snapshotId),
        }))}
        errors={this.orphanPinErrors}
        notice={
          this.orphanPinNotice === undefined
            ? undefined
            : this.t('notice.pin-skipped', { count: this.orphanPinNotice })
        }
        fetchError={
          this.orphanPinFetchError
            ? this.orphanPinFetchError.localize
              ? this.errorMessage(this.orphanPinFetchError.detail)
              : this.orphanPinFetchError.detail.message
            : undefined
        }
        canRelease={this.canEffect('packages.remove') && this.orphanPinList.length > 0}
        onRelease={(pinIds, trigger) => this.confirmReleasePins(pinIds, trigger)}
      />
    </UiLocaleProvider>,
  )
  renderRegion(
    this.listHost,
    <UiLocaleProvider source={this.locale}>
      <SettingsHub
        api={this.api}
        canInstall={this.canEffect('packages.install')}
        canSave={this.canEffect('packages.activate')}
        pluginText={this.t}
        installed={this.state.installed}
        generations={this.state.generations}
        onPage={this.onSettingsPage}
        onReview={this.reviewExample}
        onRefresh={this.refreshSettings}
        {...(this.schedules ? { schedules: this.schedules } : {})}
      >
        <PluginOperationFeedback operation={this.state.lastOperation} installed={this.state.installed} />
        <div data-testid="plugin-browser">
          <SettingsPageHeader
            title={this.tab === 'installed' ? this.t('ux.plugins') : this.t('ux.discover')}
            description={this.t('ux.description')}
            actions={
              <Menu
                label={this.t('ux.add')}
                trigger={
                  <Button id="install-source" appearance="primary" icon={<Icon name="plus" />}>
                    {this.t('ux.add')}
                  </Button>
                }
                items={[
                  {
                    id: 'discover',
                    label: this.t('ux.browse'),
                    onSelect: () =>
                      document.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: 'discover' })),
                  },
                  {
                    id: 'source',
                    testId: 'plugin-install-source',
                    label: this.t('shell.install'),
                    disabled: !this.canEffect('packages.install'),
                    disabledReason: this.t('connection.forbidden'),
                    onSelect: () => this.openSourceDialog('install'),
                  },
                  {
                    id: 'creator',
                    testId: 'plugin-creator',
                    label: this.settingsText('creator'),
                    onSelect: () =>
                      location.assign(sessionStartUrl(undefined, this.settingsText('creatorPrompt'))),
                  },
                ]}
              />
            }
          />
          <Tabs
            activeKey={this.tab}
            onChange={(key) =>
              document.dispatchEvent(
                new CustomEvent('agnes:settings-page', {
                  detail: key === 'installed' ? 'plugins' : 'discover',
                }),
              )
            }
            items={[
              { key: 'installed', label: this.t('ux.installed') },
              { key: 'discover', label: this.t('ux.discover') },
            ]}
          />

          <SettingsToolbar
            data-testid="plugin-toolbar"
            search={
              <Field label={this.t('shell.search.aria')} htmlFor="plugin-search">
                <SettingsInput
                  id="plugin-search"
                  type="search"
                  value={this.queryRaw}
                  placeholder={this.purposeText('search')}
                  disabled={!context || !this.can('packages.read')}
                  onChange={(event) => {
                    this.queryRaw = event.target.value
                    this.query = event.target.value.trim()
                    if (this.tab === 'installed') this.render()
                    else void this.loadCatalog()
                  }}
                />
              </Field>
            }
            filters={
              <Popover
                trigger="click"
                content={
                  <>
                    <Field label={this.purposeText('category')} htmlFor="plugin-category">
                      <SettingsSelect
                        id="plugin-category"
                        data-testid="plugin-category-filter"
                        value={this.category}
                        onChange={(event) => {
                          this.category = event.target.value
                          this.render()
                        }}
                      >
                        <option value="">{this.purposeText('all')}</option>
                        {PLUGIN_CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {this.purposeText(`category.${category}`)}
                          </option>
                        ))}
                        <option value="unclassified">{this.purposeText('unclassified')}</option>
                      </SettingsSelect>
                    </Field>
                    <SettingsDetails title={this.t('ux.moreFilters')}>
                      <KindFilter
                        value={this.kind}
                        t={this.t}
                        onChange={(value) => {
                          this.kind = value
                          this.render()
                        }}
                      />
                    </SettingsDetails>
                  </>
                }
              >
                <Button icon={<Icon name="sliders-horizontal" />}>
                  {this.t('ux.filter')}
                  <Count
                    value={Number(!!this.category) + Number(!!this.kind)}
                    label={this.t('ux.activeFilters')}
                  />
                </Button>
              </Popover>
            }
          />
          {this.tab === 'discover' && !this.query && !this.category && !this.kind && (
            <section aria-label={this.t('ux.examples')}>
              <h3>{this.t('ux.examples')}</h3>
              <OfficialExampleCards
                api={this.api}
                canInstall={this.canEffect('packages.install')}
                installed={this.state.installed}
                t={this.settingsText}
                onReview={this.reviewExample}
              />
            </section>
          )}
          <PluginList
            emptyActions={
              this.tab === 'installed' ? (
                <Button
                  onClick={() =>
                    document.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: 'discover' }))
                  }
                >
                  {this.t('ux.browse')}
                </Button>
              ) : undefined
            }
            menuOf={(item) => [
              ...('desired' in item && item.presentation?.rows.some((row) => row.settings)
                ? [
                    {
                      id: 'settings',
                      label: this.t('ux.settings'),
                      onSelect: () => {
                        this.selectItem(item)
                        this.detail.querySelector<HTMLElement>('[data-testid=plugin-config-tab]')?.click()
                      },
                    },
                  ]
                : []),
              { id: 'details', label: this.t('ux.details'), onSelect: () => this.selectItem(item) },
              ...('desired' in item
                ? this.detailActions(item)
                    .filter((action) => !action.href)
                    .map((action, index) => ({
                      id: `action-${index}`,
                      label: action.label,
                      disabled: action.disabled ?? false,
                      ...(action.title ? { disabledReason: action.title } : {}),
                      danger: action.className.includes('danger'),
                      onSelect: action.onClick,
                    }))
                : []),
            ]}
            providesOf={(item) => this.presentationOf(item)}
            formatFailure={(message, code) => pluginFailureMessage(message, this.t, code)}
            metadataOf={(item) => (
              <PluginBadges item={item} runtime={this.runtimeState(item.id)} t={this.t} />
            )}
            tab={this.tab}
            rows={(this.tab === 'installed' ? this.filteredInstalled() : this.state.catalog).filter(
              (item) =>
                (!this.kind || item.kinds?.includes(this.kind)) &&
                (!this.category || (item.metadata?.category ?? 'unclassified') === this.category),
            )}
            loading={loading}
            inventoryAuthoritative={this.state.inventoryAuthoritative}
            query={this.query}
            filtered={!!this.kind || !!this.category}
            nextCursor={this.state.nextCursor}
            surfaceLinksOf={(packageId) => this.surfaceLinks(packageId)}
            highlight={
              this.state.lastOperation?.state === 'completed' &&
              ['install', 'update'].includes(this.state.lastOperation.operation) &&
              this.state.lastOperation.packageId
                ? { key: this.state.lastOperation.operationId, id: this.state.lastOperation.packageId }
                : undefined
            }
            pendingOf={(item) => this.packageBusy(item.id)}
            runtimeOf={(packageId) => asRuntimeView(this.runtimeState(packageId))}
            primaryActionOf={(item) => this.primaryAction(item)}
            switchDisabledOf={(installed) =>
              !this.canEffect('packages.activate') ||
              (!installed.trusted && (!this.can('packages.trust') || !installed.capabilityHash)) ||
              this.packageBusy(installed.id)
            }
            onOpen={(item) => this.selectItem(item)}
            onToggleDesired={(item, next) =>
              void (next ? this.confirmEnable(item) : this.confirmDisable(item))
            }
            onLoadMore={() => void this.loadCatalog(this.state.nextCursor ?? undefined)}
          />
        </div>
        <CandidateInbox
          scope="plugin"
          sessionTitle={this.candidateSessionTitle}
          sessionTurnTime={this.candidateSessionTurnTime}
          api={this.api}
          canReview={
            this.canEffect('packages.trust') &&
            this.canEffect('packages.install') &&
            this.canEffect('packages.activate')
          }
          canTest={this.canEffect('extensions.execute')}
          t={this.t}
          confirm={(input) => this.configureConfirm(input)}
          onPublished={() => this.refresh()}
        />
      </SettingsHub>
    </UiLocaleProvider>,
  )
  this.layout.dataset.detail = String(this.hasDetail())
  this.renderDetail()
  this.renderConfirm()
  this.renderSource()
}

export function renderDetailPluginView(this: PluginAdminViewContext): void {
  // Source entry takes over the modal stack until it is submitted or dismissed. A retained
  // detail selection must not reopen its dialog and close the form on every catalog refresh.
  if (this.sourceDialog.open || this.confirmDialog.open) return
  const item =
    this.tab === 'installed'
      ? this.state.installed.find((candidate) => candidate.id === this.state.selectedId)
      : this.state.selectedCatalog
  if (!item) {
    if (!this.hasDetail()) {
      setDialog(this.detail, false)
      renderRegion(this.detail, <UiLocaleProvider source={this.locale} />)
      return
    }
    // 不传焦点目标：render 每 1.2 秒被刷新触发一次，抢焦点会打断弹窗里的输入。
    setDialog(this.detail, true)
    renderRegion(
      this.detail,
      <UiLocaleProvider source={this.locale}>
        <DetailContent
          heading={
            this.state.operations.size ? this.t('detail.heading.operations') : this.t('detail.heading.plugin')
          }
          intro={
            this.state.operations.size ? this.t('detail.intro.operations') : this.t('detail.intro.plugin')
          }
          version={undefined}
          stateText={undefined}
          facts={[]}
          blockerSections={[
            {
              title: this.t('blocker.operation'),
              items: (this.state.error?.blockers ?? []).map((blocker) => blockerText(blocker, this.adminT)),
            },
          ]}
          operations={this.detailOperations()}
          lastOperationLabel={
            this.state.lastOperation
              ? `${operationLabel(this.state.lastOperation, this.adminT)}${this.state.lastOperation.retryable ? ` · ${this.t('detail.retry-allowed')}` : ''}`
              : undefined
          }
          actions={[]}
          onClose={() => this.closeDetail()}
          onCancelOperation={(operationId, trigger) => void this.cancelOperation(operationId, trigger)}
        />
      </UiLocaleProvider>,
    )
    return
  }
  // 不传焦点目标：render 每 1.2 秒被刷新触发一次，抢焦点会打断弹窗里的操作。
  setDialog(this.detail, true)
  const runtimeFailure = this.runtimeState(item.id)?.error
  const failureReason =
    runtimeFailure?.message ?? ('actual' in item && item.actual !== 'running' ? item.actualReason : undefined)
  const failureMessage = failureReason
    ? pluginFailureMessage(failureReason, this.t, runtimeFailure?.code)
    : undefined
  const facts: (readonly [string, string])[] = [
    [this.t('fact.source'), sourceLabel(item.source as PackageSource, this.adminT)],
    [this.t('fact.integrity'), integrityLabel(item.integrity)],
    [this.t('fact.contribution'), contributionText(item, this.adminT)],
  ]
  if ('license' in item) facts.push([this.t('fact.license'), item.license])
  if ('desired' in item) {
    // Manifest slots are an author declaration. This fact is intentionally derived from the
    // live browser registry so the operator can distinguish a declaration from what this page
    // actually registered in the current browser session.
    const actualSlotList = this.actualSlots?.(item.id) ?? []
    facts.push([
      this.t('fact.browser-slots'),
      actualSlotList.length
        ? actualSlotList.join(this.locale.getSnapshot() === 'en' ? ', ' : '、')
        : this.t('fact.no-browser-slots'),
    ])
    const runtime = this.runtimeState(item.id)
    const failureReason =
      runtime?.error?.message ?? (item.actual === 'running' ? undefined : item.actualReason)
    if (failureReason)
      facts.push([this.t('fact.failure'), pluginFailureMessage(failureReason, this.t, runtime?.error?.code)])
    facts.push([
      this.t('fact.cleanup'),
      item.cleanupPending ? this.t('fact.cleanup-pending') : this.t('fact.cleanup-none'),
    ])
    facts.push([
      this.t('fact.rollback-target'),
      item.rollbackTarget
        ? `${item.rollbackTarget.version} · ${integrityLabel(item.rollbackTarget.integrity)}`
        : this.t('fact.unavailable'),
    ])
  }
  renderRegion(
    this.detail,
    <UiLocaleProvider source={this.locale}>
      <DetailContent
        heading={resolvePluginMetadata(item.metadata, this.locale.getSnapshot())?.displayName ?? item.id}
        intro={resolvePluginMetadata(item.metadata, this.locale.getSnapshot())?.summary ?? ''}
        version={undefined}
        stateText={undefined}
        facts={[]}
        content={
          <PluginConfigTab
            key={item.id}
            context={this.state.context!}
            id={item.id}
            installed={this.tab === 'installed'}
            onClose={() => this.closeDetail()}
            permissions={
              <section data-testid="plugin-permissions-detail">
                <PluginBadges item={item} runtime={this.runtimeState(item.id)} t={this.t} />
                {'desired' in item && (
                  <>
                    <ProvenanceReview value={item.provenance} t={this.t} />
                    <CapabilityReview value={item.declaredCapabilities} t={this.t} />
                  </>
                )}
                {'desired' in item &&
                (item.actual === 'failed' ||
                  item.blockers.length ||
                  this.runtimeState(item.id)?.phase === 'failed') ? (
                  <FailureHelp
                    reason={
                      item.blockers.length
                        ? 'capability blocked'
                        : (this.runtimeState(item.id)?.error?.message ?? item.actualReason ?? '')
                    }
                    t={this.t}
                  />
                ) : undefined}
              </section>
            }
            versions={
              <PluginPurposeSections
                item={item}
                value={this.presentationOf(item)}
                section="versions"
                permissions={null}
                versions={
                  <>
                    <p>{this.t('version', { version: item.version })}</p>
                    <GenerationDrainSummary
                      status={this.state.generations}
                      installed={this.state.installed.filter((row) => row.id === item.id)}
                      t={this.t}
                      nameOf={() =>
                        resolvePluginMetadata(item.metadata, this.locale.getSnapshot())?.displayName ??
                        item.id
                      }
                    />
                    <SettingsDetails title={this.purposeText('technical')}>
                      <code>{item.id}</code>
                      <PluginDetailCopy
                        value={JSON.stringify(
                          {
                            id: item.id,
                            version: item.version,
                            source: item.source,
                            integrity: item.integrity,
                          },
                          null,
                          2,
                        )}
                      />
                      <dl className="plugin-facts">
                        {facts.map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </SettingsDetails>
                  </>
                }
              />
            }
            settingsSummary={
              <PluginPurposeSections
                item={item}
                value={this.presentationOf(item)}
                section="settings"
                permissions={null}
                versions={null}
              />
            }
          >
            {failureMessage && <SettingsState tone="error">{failureMessage}</SettingsState>}
            <PluginPurposeSections
              item={item}
              value={this.presentationOf(item)}
              section="overview"
              permissions={null}
              versions={null}
            />
          </PluginConfigTab>
        }
        blockerSections={[
          {
            title: this.t('blocker.current'),
            items: ('blockers' in item ? item.blockers : []).map((blocker) =>
              blockerText(blocker, this.adminT),
            ),
          },
          {
            title: this.t('blocker.operation'),
            items: (this.state.error?.blockers ?? []).map((blocker) => blockerText(blocker, this.adminT)),
          },
        ]}
        operations={this.detailOperations(item.id)}
        lastOperationLabel={undefined}
        actions={this.detailActions(item)}
        onClose={() => this.closeDetail()}
        onCancelOperation={(operationId, trigger) => void this.cancelOperation(operationId, trigger)}
      />
    </UiLocaleProvider>,
  )
}

export function renderConfirmPluginView(this: PluginAdminViewContext): void {
  const pending = this.pendingConfirm
  if (!pending) {
    renderRegion(this.confirmDialog, <UiLocaleProvider source={this.locale} />)
    return
  }
  renderRegion(
    this.confirmDialog,
    <UiLocaleProvider source={this.locale}>
      <ConfirmDialogContent
        title={typeof pending.title === 'function' ? pending.title() : pending.title}
        description={typeof pending.description === 'function' ? pending.description() : pending.description}
        facts={pending.facts}
        actionLabel={typeof pending.label === 'function' ? pending.label() : pending.label}
        actionDisabled={this.confirmActionDisabled}
        onAction={() => {
          if (!this.pendingConfirm) return
          this.confirmActionDisabled = true
          this.renderConfirm()
          void this.pendingConfirm
            .run()
            .then(() => this.closeConfirm())
            .catch((error: unknown) => this.showError(error))
            .finally(() => {
              // 确认框在失败路径保持打开：按钮必须复位为可重试，而不是停在置灰。
              this.confirmActionDisabled = false
              this.renderConfirm()
            })
        }}
        onCancel={() => this.closeConfirm()}
      />
    </UiLocaleProvider>,
  )
}

export function renderSourcePluginView(this: PluginAdminViewContext): void {
  renderRegion(
    this.sourceDialog,
    <UiLocaleProvider source={this.locale}>
      <SourceDialogContent
        title={this.sourceTitle()}
        intro={this.sourceIntro()}
        typeOptions={SOURCE_TYPE_OPTIONS.map(({ value }) => ({
          value,
          label: ['path', 'url'].includes(value)
            ? this.t(`capability.source.${value}`)
            : this.adminT(`source.${value}`),
        }))}
        type={this.sourceTypeValue}
        ref_={this.sourceRefValue}
        placeholder={this.sourcePlaceholder}
        error={
          this.sourceProblem
            ? (sourceProblem(this.sourceProblem.type, this.sourceProblem.ref, this.t) ??
              this.t('source.error.incomplete'))
            : this.sourceError
              ? this.errorMessage(this.sourceError)
              : ''
        }
        busy={this.sourceBusy}
        onTypeChange={(type) => {
          this.sourceTypeValue = type
          this.syncSourceHint()
          this.render()
        }}
        onRefChange={(ref) => {
          this.sourceRefValue = ref
        }}
        onSubmit={() => this.submitSource()}
        onCancel={() => this.closeSourceDialog()}
      />
    </UiLocaleProvider>,
  )
}
