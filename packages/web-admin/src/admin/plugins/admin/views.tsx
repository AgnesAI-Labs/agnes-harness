import type { PackageSource } from '@agnes/protocol'
import {
  Button,
  blockerText,
  ConfirmDialogContent,
  contributionText,
  DetailContent,
  Field,
  integrityLabel,
  OrphanPins,
  operationLabel,
  PluginList,
  renderRegion,
  SettingsInput,
  SettingsToolbar,
  SourceDialogContent,
  sourceLabel,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { SettingsHub } from '../../../settings/hub.js'
import { sessionStartUrl } from '../../../settings/runtime-panels.js'
import { CandidateInbox } from '../candidates.js'
import { CapabilityReview, FailureHelp, ProvenanceReview } from '../capability-review.js'
import { GenerationDrainSummary, KindFilter, PluginBadges, pluginFailureMessage } from '../control-panel.js'
import { sourceProblem } from '../source-form.js'
import { setDialog } from './dom.js'
import { pinPurposeLabel, asRuntimeView } from './model.js'
import type { PluginAdminViewContext } from './page.js'

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
        <CandidateInbox
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
        <GenerationDrainSummary
          nameOf={(id) => {
            const key = `example.name.${id.split('/').at(-1)}`
            const name = this.settingsText(key)
            return /^@(agnes-example|agnes-fde|community)\//.test(id) && name !== key
              ? name
              : id.split('/').at(-1)!
          }}
          status={this.state.generations}
          installed={this.state.installed}
          t={this.t}
        />
        <SettingsToolbar data-testid="plugin-toolbar">
          <Field label={this.t('shell.search.aria')} htmlFor="plugin-search">
            <SettingsInput
              id="plugin-search"
              type="search"
              value={this.queryRaw}
              placeholder={this.t(this.tab === 'installed' ? 'search.installed' : 'search.discover')}
              disabled={!context || !this.can('packages.read')}
              onChange={(event) => {
                this.queryRaw = event.target.value
                this.query = event.target.value.trim()
                if (this.tab === 'installed') this.render()
                else void this.loadCatalog()
              }}
            />
          </Field>
          <KindFilter
            value={this.kind}
            t={this.t}
            onChange={(value) => {
              this.kind = value
              this.render()
            }}
          />
          <Button
            id="install-source"
            type="primary"
            disabled={!this.canEffect('packages.install')}
            onClick={() => this.openSourceDialog('install')}
          >
            {this.t('shell.install')}
          </Button>
          <Button
            data-testid="plugin-creator"
            href={sessionStartUrl(undefined, this.settingsText('creatorPrompt'))}
          >
            {this.settingsText('creator')}
          </Button>
        </SettingsToolbar>
        <PluginList
          presentationOf={(item) => {
            if (!/^@(agnes-example|agnes-fde|community)\//.test(item.id)) return undefined
            const name = item.id.split('/').at(-1)
            const key = `example.name.${name}`
            const label = this.settingsText(key)
            if (label === key) return undefined
            const descriptionKey = item.id.startsWith('@agnes-fde/')
              ? 'example.summary.fde'
              : `example.summary.${name}`
            const description = this.settingsText(descriptionKey)
            return { name: label, ...(description === descriptionKey ? {} : { description }) }
          }}
          formatFailure={(message, code) => pluginFailureMessage(message, this.t, code)}
          metadataOf={(item) => <PluginBadges item={item} runtime={this.runtimeState(item.id)} t={this.t} />}
          tab={this.tab}
          rows={(this.tab === 'installed' ? this.filteredInstalled() : this.state.catalog).filter(
            (item) => !this.kind || item.kinds?.includes(this.kind),
          )}
          loading={loading}
          inventoryAuthoritative={this.state.inventoryAuthoritative}
          query={this.query}
          nextCursor={this.state.nextCursor}
          surfaceLinksOf={(packageId) => this.surfaceLinks(packageId)}
          runtimeOf={(packageId) => asRuntimeView(this.runtimeState(packageId))}
          primaryActionOf={(item) => this.primaryAction(item)}
          switchDisabledOf={(installed) =>
            !this.canEffect('packages.activate') ||
            (!installed.trusted && (!this.can('packages.trust') || !installed.capabilityHash)) ||
            this.packageBusy(installed.id)
          }
          onOpen={(item) => this.selectItem(item)}
          onToggleDesired={(item, next) => void (next ? this.confirmEnable(item) : this.confirmDisable(item))}
          onLoadMore={() => void this.loadCatalog(this.state.nextCursor ?? undefined)}
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
        heading={item.id}
        metadata={
          <>
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
          </>
        }
        intro=""
        version={this.t('version', { version: item.version })}
        stateText={
          'trusted' in item
            ? undefined
            : this.t('compatibility', { value: this.t(`compatibility.${item.compatibility}`) })
        }
        facts={facts}
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
