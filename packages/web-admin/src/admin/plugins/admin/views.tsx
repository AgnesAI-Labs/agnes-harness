import { resolvePluginMetadata } from '@agnes/protocol'
import { presentationRoles } from '@agnes/web-client'
import {
  Button,
  blockerText,
  ConfirmDialogContent,
  Count,
  DetailContent,
  Field,
  Icon,
  Menu,
  OrphanPins,
  operationLabel,
  PluginList,
  Popover,
  pluginOrigin,
  renderRegion,
  SearchBar,
  SettingsDetails,
  SettingsPageHeader,
  SettingsSelect,
  SettingsTechnicalDetails,
  SourceDialogContent,
  StateSwitch,
  StatusMessage,
  Tabs,
  UiLocaleProvider,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { SettingsHub } from '../../../settings/hub.js'
import { sessionStartUrl } from '../../../settings/runtime-panels.js'
import { CandidateInbox } from '../candidates.js'
import { KindFilter, pluginFailureMessage } from '../control-panel.js'
import { PluginDetailCopy } from '../detail-copy.js'
import { PluginOperationFeedback } from '../operation-feedback.js'
import { SOURCE_FORMATS, sourceProblem } from '../source-form.js'
import { PluginDetailBody } from './detail-body.js'
import { setDialog } from './dom.js'
import { asRuntimeView, pinPurposeLabel } from './model.js'
import type { PluginAdminViewContext } from './page.js'

/** Host diagnostics remain visible even when a presentation fails before returning cleanup. */
function PresentationDiagnostics() {
  const diagnostics = useSyncExternalStore(presentationRoles.subscribe, presentationRoles.getSnapshot)
  const zh = useDocumentLanguage() === 'zh-CN'
  return (
    <>
      {diagnostics.map((item) => (
        <StatusMessage
          key={item.role}
          kind="error"
          action={{
            label: zh ? '重新加载' : 'Reload',
            onSelect: () => window.location.reload(),
          }}
        >
          {zh
            ? item.reason === 'conflict'
              ? '接管冲突'
              : '界面显示失败；已保存的交付物可能仍然存在。请重新加载。'
            : item.reason === 'conflict'
              ? 'Presentation conflict'
              : 'Display failed; saved deliverables may still exist. Reload to try again.'}
          {`: ${item.role} · ${item.failure?.packageId ?? item.owners.join(', ')}`}
          {item.failure && ` · ${item.failure.phase} · ${item.failure.code}`}
        </StatusMessage>
      ))}
    </>
  )
}

const SOURCE_TYPE_OPTIONS = Object.keys(SOURCE_FORMATS)
  .filter((type) => type !== 'local')
  .map((type) => ({
    value: type,
    label: type,
  }))

/** The one status line of the plugin surface, and the tree line under it. */
export function pluginNotice(view: PluginAdminViewContext): {
  message: string
  kind: 'error' | 'state' | ''
  tree: string
} {
  return notice.call(view)
}

function notice(this: PluginAdminViewContext) {
  const { connection, error, tree } = this.state
  // Reading needs no words of its own: the list shows its placeholder and the top bar moves.
  const connectionNotice =
    connection === 'offline'
      ? this.t('connection.offline')
      : connection === 'forbidden'
        ? this.t('connection.forbidden')
        : ''
  // What blocked the operation (a session pin, a dependent plugin) is the reason the line gives.
  const reasons = (error?.blockers ?? []).map((blocker) => blockerText(blocker, this.adminT))
  const errorText = (message: string) =>
    reasons.length
      ? this.t('notice.error-reasons', { message, reasons: reasons.join(this.adminT('list.separator')) })
      : message
  const noticeMessage = error
    ? this.state.lastOperation
      ? this.t('notice.operation-error', {
          operation: operationLabel(this.state.lastOperation, this.adminT),
          message: errorText(this.errorMessage(error, this.state.lastOperation.operation)),
        })
      : errorText(this.errorMessage(error))
    : this.state.loading
      ? ''
      : this.state.lastOperation
        ? this.t('notice.operation-refreshed', {
            operation: operationLabel(this.state.lastOperation, this.adminT),
          })
        : this.noticeText() || connectionNotice
  const noticeKind = error ? 'error' : connection === 'connected' ? this.noticeState.kind : 'state'
  const treeText =
    tree?.desiredDigest && !tree.actual
      ? tree.failurePhase && !tree.pending
        ? this.t('tree.error')
        : this.t('tree.loading')
      : ''
  return { message: noticeMessage, kind: noticeKind, tree: treeText } as const
}

export function renderPluginView(this: PluginAdminViewContext): void {
  if (this.surface) {
    // The full page draws its own status, recovery banner and layout from the same view.
    renderRegion(
      this.listHost,
      <UiLocaleProvider source={this.locale}>
        <PresentationDiagnostics />
        {this.surface.render(this)}
      </UiLocaleProvider>,
    )
    this.renderDetail()
    this.renderConfirm()
    this.renderSource()
    return
  }
  const { context, loading } = this.state
  // Notices, tree status and recovery banners are single-line skeleton text nodes assigned imperatively; list rows,
  // detail bodies and dialog contents all live in the React regions below.
  this.recovery.hidden = !context?.readOnly
  this.layout.dataset.detail = String(this.hasDetail())
  const { message: noticeMessage, kind: noticeKind, tree: treeText } = notice.call(this)
  this.notice.textContent = noticeMessage
  this.notice.dataset.kind = noticeKind
  this.treeStatus.textContent = treeText
  this.treeStatus.hidden = !treeText
  this.orphanPinsHost.hidden = this.orphanPinList.length === 0 && !this.orphanPinFetchError
  renderRegion(
    this.orphanPinsHost,
    <UiLocaleProvider source={this.locale}>
      <SettingsTechnicalDetails>
        <OrphanPins
          pins={this.orphanPinList.map((pin) => ({
            pinId: pin.pinId,
            packageId: pin.packageId,
            version: pin.version,
            purpose: pinPurposeLabel(pin.purpose, this.t),
            snapshotId: pin.snapshotId,
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
        <PluginDetailCopy value={JSON.stringify(this.orphanPinList, null, 2)} />
      </SettingsTechnicalDetails>
    </UiLocaleProvider>,
  )
  renderRegion(
    this.listHost,
    <UiLocaleProvider source={this.locale}>
      <PresentationDiagnostics />
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

          <SearchBar
            data-testid="plugin-toolbar"
            label={this.t('shell.search.aria')}
            placeholder={this.purposeText('search')}
            value={this.queryRaw}
            onChange={(value) => {
              this.queryRaw = value
              this.query = value.trim()
              if (this.tab === 'installed') this.render()
              else void this.loadCatalog()
            }}
            inputProps={{ id: 'plugin-search', disabled: !context || !this.can('packages.read') }}
            filters={
              <Popover
                trigger="click"
                content={
                  <>
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
                  <Count value={Number(!!this.kind)} label={this.t('ux.activeFilters')} />
                </Button>
              </Popover>
            }
          />
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
            tab={this.tab}
            rows={(this.tab === 'installed' ? this.filteredInstalled() : this.state.catalog).filter(
              (item) => (!this.kind || item.provides?.includes(this.kind)) && !item.metadata?.exampleOf,
            )}
            loading={loading}
            inventoryAuthoritative={this.state.inventoryAuthoritative}
            query={this.query}
            filtered={!!this.kind}
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
    // Pass no focus target: refresh renders every 1.2 seconds and stealing focus would interrupt dialog input.
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
  // Pass no focus target: refresh renders every 1.2 seconds and stealing focus would interrupt dialog interaction.
  setDialog(this.detail, true)
  const purpose = resolvePluginMetadata(item.metadata, this.locale.getSnapshot())
  const name = purpose?.displayName ?? item.id
  const actions = this.detailActions(item)
  const installed = 'desired' in item ? item : undefined
  const enabled = installed?.desired === 'enabled'
  renderRegion(
    this.detail,
    <UiLocaleProvider source={this.locale}>
      <DetailContent
        heading={name}
        intro={purpose?.summary ?? ''}
        version={`${this.purposeText(`origin.${pluginOrigin(item)}`)} · ${item.version}`}
        stateText={undefined}
        facts={[]}
        headAction={
          installed && (
            <StateSwitch
              testId="plugin-detail-switch"
              label={this.t(enabled ? 'detail.switch.disable' : 'detail.switch.enable', { name })}
              checked={enabled}
              busy={this.packageBusy(item.id)}
              disabled={
                !this.canEffect('packages.activate') ||
                (!installed.trusted && (!this.can('packages.trust') || !installed.capabilityHash)) ||
                this.packageBusy(item.id)
              }
              onToggle={(next) =>
                void (next ? this.confirmEnable(installed) : this.confirmDisable(installed))
              }
            />
          )
        }
        content={<PluginDetailBody view={this} item={item} actions={actions} />}
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
        actions={actions.filter((action) => !action.group)}
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
        danger={pending.danger}
        secondaryLabel={pending.secondary?.label()}
        onAction={(secondary) => {
          if (!this.pendingConfirm) return
          this.confirmActionDisabled = true
          this.renderConfirm()
          void (secondary ? (this.pendingConfirm.secondary ?? this.pendingConfirm) : this.pendingConfirm)
            .run()
            .then(() => this.closeConfirm())
            .catch((error: unknown) => this.showError(error))
            .finally(() => {
              // Keep confirmation open on failure: restore the button for retry rather than leaving it disabled.
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
          this.renderSource()
        }}
        onSubmit={() => this.submitSource()}
        onCancel={() => this.closeSourceDialog()}
      />
    </UiLocaleProvider>,
  )
}
