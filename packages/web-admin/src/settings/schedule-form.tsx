import {
  Button,
  Field,
  MetaText,
  PushPage,
  Segmented,
  SessionPicker,
  SettingsChoice,
  SettingsGroup,
  SettingsInput,
  SettingsPickerSelect,
  SettingsState,
  SettingsTextArea,
  StateSwitch,
  StatusMessage,
} from '@agnes/web-ui'
import { useState } from 'react'
import {
  folderName,
  type ScheduleChoices,
  type ScheduleRow,
  type ScheduleTarget,
  type SessionInfo,
  type Workspace,
} from './schedule-model.js'
import {
  isoFromLocal,
  localInput,
  localTimeZone,
  nextRun,
  selectorKind,
  type Text,
  when,
} from './schedule-text.js'

export type Frequency = 'once' | 'every' | 'daily' | 'weekly' | 'cron'
const FREQUENCIES: readonly Frequency[] = ['once', 'every', 'daily', 'weekly', 'cron']
type TargetKind = ScheduleTarget['kind']

/** Everything the dialog edits, as plain form values. */
export type ScheduleDraft = {
  title: string
  unattendedApproval?: 'notify' | 'refuse'
  prompt: string
  target: TargetKind
  cwd: string
  mode: string
  preset: string
  model: string
  sessionKey: string
  frequency: Frequency
  at: string
  every: string
  unit: 'seconds' | 'minutes' | 'hours'
  time: string
  weekdays: number[]
  cron: string
  zone: string
  /**
   * The target as saved, with the form values it was shown as. Saving keeps each part the person did
   * not change exactly as it was (loop, ordered bundles, model), even when the current catalog no
   * longer lists it or could not be read.
   */
  saved?: { target: ScheduleTarget; mode: string; model: string } | undefined
}

export function emptyDraft(o: {
  sessionKey?: string | undefined
  cwd?: string | undefined
  now: number
}): ScheduleDraft {
  return {
    title: '',
    prompt: '',
    // From a session, a task most often continues it; from the automation page, it runs on its own.
    target: 'new-session',
    cwd: o.cwd ?? '',
    mode: '',
    preset: '',
    model: '',
    sessionKey: o.sessionKey ?? '',
    frequency: 'daily',
    at: localInput(o.now + 3_600_000),
    every: '60',
    unit: 'minutes',
    time: '09:00',
    weekdays: [1],
    cron: '0 9 * * 1-5',
    zone: localTimeZone(),
  }
}

/** A saved task as form values. A create-only "after N seconds" rule edits as its next run time. */
export function draftOf(row: ScheduleRow, choices: ScheduleChoices, now: number): ScheduleDraft {
  const draft = emptyDraft({ now })
  const target = row.target
  const mode =
    target.kind === 'new-session' && target.loop
      ? (choices.modes.find(
          (item) =>
            item.loop.id === target.loop?.id &&
            item.loop.version === target.loop?.version &&
            JSON.stringify(item.bundles) === JSON.stringify(target.bundles ?? []) &&
            (!item.preset || item.preset === target.preset),
        )?.key ?? `${target.loop.id}@${target.loop.version}`)
      : ''
  const model =
    target.kind === 'new-session' && target.model ? `${target.model.route}\u0000${target.model.model}` : ''
  const base: ScheduleDraft = {
    ...draft,
    title: row.title,
    ...(row.target.unattendedApproval ? { unattendedApproval: row.target.unattendedApproval } : {}),
    prompt: row.prompt,
    target: target.kind,
    cwd: target.kind === 'new-session' ? target.cwd : '',
    mode,
    preset: target.kind === 'new-session' ? (target.preset ?? '') : '',
    model,
    sessionKey: target.kind === 'session' ? target.sessionKey : '',
    saved: { target, mode, model },
  }
  const kind = selectorKind(row.selector)
  const value = kind ? row.selector[kind] : undefined
  const fields = (value && typeof value === 'object' ? value : {}) as {
    time?: string
    timeZone?: string
    weekdays?: number[]
    expr?: string
  }
  if (kind === 'at') return { ...base, frequency: 'once', at: localInput(Date.parse(String(value))) }
  if (kind === 'after_seconds')
    return { ...base, frequency: 'once', at: localInput(row.nextRunAt ?? now + Number(value) * 1000) }
  if (kind === 'every_seconds') {
    const seconds = Number(value)
    // Whole hours or minutes read as such; any other period keeps its exact seconds.
    return seconds % 3600 === 0
      ? { ...base, frequency: 'every', every: String(seconds / 3600), unit: 'hours' }
      : seconds % 60 === 0
        ? { ...base, frequency: 'every', every: String(seconds / 60), unit: 'minutes' }
        : { ...base, frequency: 'every', every: String(seconds), unit: 'seconds' }
  }
  if (kind === 'daily' || kind === 'weekly')
    return {
      ...base,
      frequency: kind,
      time: fields.time ?? '09:00',
      weekdays: (fields.weekdays ?? [1]).map((day) => (day === 7 ? 0 : day)),
      zone: fields.timeZone ?? draft.zone,
    }
  if (kind === 'cron')
    return {
      ...base,
      frequency: 'cron',
      cron: fields.expr ?? draft.cron,
      zone: fields.timeZone ?? draft.zone,
    }
  return base
}

const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600 } as const
/** The shortest period the schedule service accepts. */
export const MIN_EVERY_SECONDS = 60
export const everySeconds = (draft: Pick<ScheduleDraft, 'every' | 'unit'>): number =>
  Math.round(Number(draft.every) * UNIT_SECONDS[draft.unit])

export function selectorOf(draft: ScheduleDraft): Record<string, unknown> {
  if (draft.frequency === 'once') return { at: isoFromLocal(draft.at) }
  if (draft.frequency === 'every') return { every_seconds: everySeconds(draft) }
  if (draft.frequency === 'daily') return { daily: { time: draft.time, timeZone: draft.zone } }
  if (draft.frequency === 'weekly')
    return { weekly: { time: draft.time, timeZone: draft.zone, weekdays: [...draft.weekdays].sort() } }
  return draft.zone
    ? { cron: { expr: draft.cron.trim(), timeZone: draft.zone } }
    : { cron: { expr: draft.cron.trim() } }
}

export function targetOf(draft: ScheduleDraft, choices: ScheduleChoices): ScheduleTarget {
  if (draft.target === 'session')
    return {
      kind: 'session',
      sessionKey: draft.sessionKey,
      ...(draft.unattendedApproval ? { unattendedApproval: draft.unattendedApproval } : {}),
    }
  const saved = draft.saved?.target.kind === 'new-session' ? draft.saved : undefined
  const before = saved?.target.kind === 'new-session' ? saved.target : undefined
  const mode = choices.modes.find((item) => item.key === draft.mode)
  const model = choices.models.find((item) => item.key === draft.model)
  // An unchanged choice, or one the catalog cannot resolve, keeps exactly what was saved.
  const keepMode = before && (draft.mode === saved?.mode || (draft.mode !== '' && !mode))
  const keepModel = before && (draft.model === saved?.model || (draft.model !== '' && !model))
  const execution = keepMode
    ? {
        ...(before.loop ? { loop: before.loop } : {}),
        ...(before.bundles?.length ? { bundles: [...before.bundles] } : {}),
      }
    : mode
      ? { loop: mode.loop, ...(mode.bundles.length ? { bundles: mode.bundles } : {}) }
      : {}
  const chosenModel = keepModel
    ? before.model
    : model
      ? { route: model.route, model: model.model }
      : !keepMode
        ? mode?.model
        : undefined
  return {
    kind: 'new-session',
    cwd: draft.cwd,
    ...(draft.unattendedApproval ? { unattendedApproval: draft.unattendedApproval } : {}),
    ...execution,
    ...((!keepMode && mode?.preset) || draft.preset
      ? { preset: (!keepMode && mode?.preset) || draft.preset }
      : {}),
    ...(chosenModel ? { model: chosenModel } : {}),
  }
}

/**
 * A permission preset by the name the rest of settings uses (`choice.<id>`); a preset a plugin adds
 * without a name keeps its id, so it is still recognisable.
 */
export const presetName = (preset: string, t: Text): string => {
  const name = t(`choice.${preset}`)
  return name === `choice.${preset}` ? preset : name
}

/** A saved choice the current catalog does not list stays selectable, marked as unavailable. */
const savedOnly = (value: string, known: readonly { key: string }[]): boolean =>
  value !== '' && !known.some((item) => item.key === value)

/** The push page that holds the schedule editor: `schedule-new`, or `schedule-<id>` for one task. */
export const schedulePageId = (id: string | undefined) => (id ? `schedule-${id}` : 'schedule-new')

/**
 * New or edit scheduled task: a page opened inside Automation (「‹ Back」, breadcrumb, a link of its own),
 * the form in the page and its two actions at the end.
 */
export function ScheduleEditor({
  pageId,
  editing,
  draft,
  onDraft,
  choices,
  workspaces,
  sessions,
  busy,
  error,
  t,
  ux,
  onCancel,
  onSubmit,
}: {
  pageId: string
  editing: boolean
  draft: ScheduleDraft
  onDraft(next: ScheduleDraft): void
  choices: ScheduleChoices
  workspaces: readonly Workspace[]
  sessions: readonly SessionInfo[]
  busy: boolean
  error: string | undefined
  t: Text
  ux: Text
  onCancel(): void
  onSubmit(): void
}) {
  const [now] = useState(() => Date.now())
  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    onDraft({ ...draft, [key]: value })
  const usable = workspaces.filter((item) => item.available || item.path === draft.cwd)
  const ready =
    draft.title.trim() !== '' &&
    draft.prompt.trim() !== '' &&
    (draft.target === 'session' ? draft.sessionKey !== '' : draft.cwd !== '') &&
    (draft.frequency !== 'weekly' || draft.weekdays.length > 0) &&
    (draft.frequency !== 'every' || everySeconds(draft) >= MIN_EVERY_SECONDS) &&
    (draft.frequency !== 'once' || draft.at !== '') &&
    (draft.frequency !== 'cron' || draft.cron.trim() !== '')
  const next = nextRun(selectorOf(draft), now)
  const zoned = draft.frequency === 'daily' || draft.frequency === 'weekly' || draft.frequency === 'cron'
  const agents = choices.modes.filter((item) => item.businessAgent)
  const loops = choices.modes.filter((item) => !item.businessAgent)
  return (
    <PushPage id={pageId} title={editing ? t('schedulesSave') : ux('newSchedule')}>
      <form
        id="schedules-editor"
        className="schedule-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && ready) onSubmit()
        }}
      >
        <Field label={ux('name')}>
          <SettingsInput
            required
            disabled={busy}
            data-testid="schedules-title"
            placeholder={ux('nameExample')}
            value={draft.title}
            onChange={(event) => set('title', event.target.value)}
          />
        </Field>
        <Field label={ux('targetLabel')}>
          <SettingsGroup
            id="schedules-target"
            data-testid="schedules-target"
            role="radiogroup"
            aria-label={ux('targetLabel')}
            className="agnes-settings-choices"
          >
            <SettingsChoice
              type="radio"
              name="schedules-target"
              value="new-session"
              label={ux('targetNew')}
              hint={ux('targetNewHint')}
              data-testid="schedules-target-new-session"
              checked={draft.target === 'new-session'}
              disabled={busy}
              onChange={() => set('target', 'new-session')}
            />
            <SettingsChoice
              type="radio"
              name="schedules-target"
              value="session"
              label={ux('targetSession')}
              hint={ux('targetSessionHint')}
              data-testid="schedules-target-session"
              checked={draft.target === 'session'}
              disabled={busy}
              onChange={() => set('target', 'session')}
            />
          </SettingsGroup>
        </Field>
        {draft.target === 'new-session' ? (
          <>
            <Field label={ux('workspace')} error={usable.length === 0 ? ux('workspaceNone') : undefined}>
              <SettingsPickerSelect
                data-testid="schedules-workspace"
                label={ux('workspace')}
                disabled={busy || usable.length === 0}
                value={draft.cwd}
                onChange={(event) => set('cwd', event.target.value)}
              >
                {draft.cwd === '' && <option value="">—</option>}
                {usable.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.name || folderName(item.path)}
                  </option>
                ))}
              </SettingsPickerSelect>
            </Field>
            {(choices.modes.length > 0 || savedOnly(draft.mode, choices.modes)) && (
              <Field label={ux('mode')}>
                <SettingsPickerSelect
                  data-testid="schedules-mode"
                  label={ux('mode')}
                  disabled={busy}
                  value={draft.mode}
                  onChange={(event) => set('mode', event.target.value)}
                >
                  <option value="">{ux('modeDefault')}</option>
                  {savedOnly(draft.mode, choices.modes) ? (
                    <option value={draft.mode} data-testid="schedules-mode-saved">
                      {ux('savedUnavailable', { name: draft.mode })}
                    </option>
                  ) : null}
                  {agents.length > 0 && (
                    <optgroup label={ux('modeAgents')}>
                      {agents.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {loops.length > 0 && (
                    <optgroup label={ux('modeLoops')}>
                      {loops.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </SettingsPickerSelect>
              </Field>
            )}
            {choices.presets.length > 0 && (
              <Field label={ux('preset')}>
                <SettingsPickerSelect
                  data-testid="schedules-preset"
                  label={ux('preset')}
                  disabled={busy}
                  value={draft.preset}
                  onChange={(event) => set('preset', event.target.value)}
                >
                  <option value="">{ux('presetDefault')}</option>
                  {choices.presets.map((preset) => (
                    <option key={preset} value={preset}>
                      {presetName(preset, t)}
                    </option>
                  ))}
                </SettingsPickerSelect>
              </Field>
            )}
            {(choices.models.length > 0 || savedOnly(draft.model, choices.models)) && (
              <Field label={ux('model')}>
                <SettingsPickerSelect
                  data-testid="schedules-model"
                  label={ux('model')}
                  disabled={busy}
                  value={draft.model}
                  onChange={(event) => set('model', event.target.value)}
                >
                  <option value="">{ux('modelDefault')}</option>
                  {savedOnly(draft.model, choices.models) ? (
                    <option value={draft.model} data-testid="schedules-model-saved">
                      {ux('savedUnavailable', { name: draft.model.replace('\u0000', ' · ') })}
                    </option>
                  ) : null}
                  {choices.models.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </SettingsPickerSelect>
              </Field>
            )}
          </>
        ) : (
          <Field label={ux('session')} error={sessions.length === 0 ? ux('sessionNone') : undefined}>
            <SessionPicker
              testId="schedules-session-picker"
              label={ux('session')}
              disabled={busy}
              locale={document.documentElement.lang || 'en'}
              value={draft.sessionKey}
              onChange={(value) => set('sessionKey', value)}
              sessions={sessions.map((session) => ({
                id: session.id,
                title: session.title || ux('sessionUntitled'),
                workspace: folderName(session.cwd),
                createdAt: session.createdAt,
              }))}
            />
          </Field>
        )}
        <Field label={ux('task')}>
          <SettingsTextArea
            required
            rows={3}
            disabled={busy}
            data-testid="schedules-prompt"
            placeholder={ux('taskExample')}
            value={draft.prompt}
            onChange={(event) => set('prompt', event.target.value)}
          />
        </Field>
        <Field label={ux('approvalBehavior')}>
          <SettingsPickerSelect
            data-testid="schedules-approval-behavior"
            label={ux('approvalBehavior')}
            disabled={busy}
            value={draft.unattendedApproval ?? 'notify'}
            onChange={(event) => set('unattendedApproval', event.target.value as 'notify' | 'refuse')}
          >
            <option value="notify">{ux('approvalNotify')}</option>
            <option value="refuse">{ux('approvalRefuse')}</option>
          </SettingsPickerSelect>
        </Field>
        <Field label={ux('frequency')}>
          <Segmented<Frequency>
            id="schedules-frequency"
            label={ux('frequency')}
            testId="schedules-kind"
            value={draft.frequency}
            disabled={busy}
            onChange={(value) => set('frequency', value)}
            options={FREQUENCIES.map((value) => ({
              value,
              label: ux(`freq.${value}`),
              testId: `schedules-kind-${value}`,
            }))}
          />
        </Field>
        {draft.frequency === 'once' && (
          <Field label={ux('onceAt')}>
            <SettingsInput
              type="datetime-local"
              data-testid="schedules-when"
              disabled={busy}
              value={draft.at}
              onChange={(event) => set('at', event.target.value)}
            />
          </Field>
        )}
        {draft.frequency === 'every' && (
          <Field
            label={ux('interval')}
            error={
              draft.every !== '' && everySeconds(draft) < MIN_EVERY_SECONDS
                ? ux('intervalMin', { n: MIN_EVERY_SECONDS })
                : undefined
            }
          >
            <span className="schedule-form-inline">
              <SettingsInput
                type="number"
                min={1}
                inputMode="numeric"
                data-testid="schedules-when"
                disabled={busy}
                value={draft.every}
                onChange={(event) => set('every', event.target.value)}
              />
              <SettingsPickerSelect
                data-testid="schedules-unit"
                label={ux('interval')}
                aria-label={ux('interval')}
                disabled={busy}
                value={draft.unit}
                onChange={(event) => set('unit', event.target.value as ScheduleDraft['unit'])}
              >
                <option value="seconds">{ux('unit.seconds')}</option>
                <option value="minutes">{ux('unit.minutes')}</option>
                <option value="hours">{ux('unit.hours')}</option>
              </SettingsPickerSelect>
            </span>
          </Field>
        )}
        {draft.frequency === 'weekly' && (
          <fieldset data-testid="schedules-weekdays" className="automation-weekdays">
            <legend>{ux('weekdays')}</legend>
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <label key={day} htmlFor={`schedule-weekday-${day}`}>
                <StateSwitch
                  id={`schedule-weekday-${day}`}
                  testId={`schedule-weekday-${day}`}
                  label={t(`schedulesDay.${day}`)}
                  disabled={busy}
                  checked={draft.weekdays.includes(day)}
                  onToggle={(checked) =>
                    set(
                      'weekdays',
                      checked ? [...draft.weekdays, day] : draft.weekdays.filter((item) => item !== day),
                    )
                  }
                />
                {t(`schedulesDay.${day}`)}
              </label>
            ))}
          </fieldset>
        )}
        {(draft.frequency === 'daily' || draft.frequency === 'weekly') && (
          <Field label={ux('time')}>
            <SettingsInput
              type="time"
              data-testid="schedules-when"
              disabled={busy}
              value={draft.time}
              onChange={(event) => set('time', event.target.value)}
            />
          </Field>
        )}
        {draft.frequency === 'cron' && (
          <Field label={ux('cron')} hint={ux('cronHint')}>
            <SettingsInput
              data-testid="schedules-cron"
              disabled={busy}
              value={draft.cron}
              onChange={(event) => set('cron', event.target.value)}
            />
          </Field>
        )}
        {zoned && (
          <Field label={ux('zone')} hint={ux('zoneHelp')}>
            <SettingsInput
              data-testid="schedules-zone"
              disabled={busy}
              value={draft.zone}
              onChange={(event) => set('zone', event.target.value)}
            />
          </Field>
        )}
        <MetaText data-testid="schedules-preview">
          {next !== undefined
            ? ux('preview', { when: when(next, ux, now) })
            : zoned
              ? ux('previewZone', { zone: draft.zone })
              : ''}
        </MetaText>
      </form>
      {error && (
        <StatusMessage
          kind="error"
          data-testid="schedules-form-error"
          action={{ label: t('schedulesSave'), onSelect: onSubmit, busy }}
        >
          {error}
        </StatusMessage>
      )}
      <div className="home-push-actions">
        <Button disabled={busy} onClick={onCancel}>
          {t('schedulesCancel')}
        </Button>
        <Button
          appearance="primary"
          htmlType="submit"
          form="schedules-editor"
          disabled={busy || !ready}
          loading={busy}
          data-testid={editing ? 'schedules-save' : 'schedules-create'}
        >
          {editing ? t('schedulesSave') : t('schedulesCreate')}
        </Button>
      </div>
    </PushPage>
  )
}
