import type { UiExtensionContext } from '@agnes/web-client'
import {
  Button,
  Icon,
  IconButton,
  type LocaleCatalog,
  SettingsInput,
  SettingsSelect,
  useUiText,
} from '@agnes/web-ui'
import { type FormEvent, useEffect, useRef, useState } from 'react'

const MHS_NAMESPACE = '@agnes/web/mhs'
const requestTypes = ['tech', 'business', 'deployment', 'other'] as const
const callingCodes = [
  ['+86', 'China', '中国'],
  ['+1', 'US / Canada', '美国 / 加拿大'],
  ['+852', 'Hong Kong', '中国香港'],
  ['+853', 'Macao', '中国澳门'],
  ['+886', 'Taiwan', '中国台湾'],
  ['+44', 'United Kingdom', '英国'],
  ['+65', 'Singapore', '新加坡'],
  ['+81', 'Japan', '日本'],
  ['+82', 'South Korea', '韩国'],
  ['+61', 'Australia', '澳大利亚'],
  ['+64', 'New Zealand', '新西兰'],
  ['+49', 'Germany', '德国'],
  ['+33', 'France', '法国'],
  ['+91', 'India', '印度'],
  ['+60', 'Malaysia', '马来西亚'],
  ['+66', 'Thailand', '泰国'],
  ['+84', 'Vietnam', '越南'],
  ['+62', 'Indonesia', '印度尼西亚'],
  ['+971', 'United Arab Emirates', '阿联酋'],
  ['+55', 'Brazil', '巴西'],
] as const
const steps: readonly (readonly [string, string, string, 'bot' | 'route' | 'send'])[] = [
  ['01', 'discoverTitle', 'discoverCopy', 'bot'],
  ['02', 'observeTitle', 'observeCopy', 'route'],
  ['03', 'coordinateTitle', 'coordinateCopy', 'send'],
]

const mhsCatalog: LocaleCatalog = {
  en: {
    brand: 'MHS',
    byline: 'by Agnes',
    robotics: 'MHS / ROBOTICS',
    hub: 'AGNES HUB',
    eyebrow: 'MODEL HARDWARE STANDARD',
    titleFirst: 'Intelligence,',
    titleSecond: 'meet the real world.',
    heroPreviewCopy: 'Robotic arm · Case demonstration',
    lead: 'MHS gives your agents one trusted interface for discovering devices, reading live state and requesting coordinated work.',
    contact: 'Talk to sales',
    proofOne: 'Device-native capabilities',
    proofTwo: 'Human-visible execution',
    proofThree: 'Built for multi-device work',
    architectureFirst: 'One connection.',
    architectureSecond: 'A world of capabilities.',
    architectureKicker: 'HOW IT WORKS',
    architectureLead:
      'MHS connects AI workflows to the capabilities your devices already expose—without turning an agent into a real-time controller.',
    discoverTitle: 'Discover',
    discoverCopy: 'Expose the tools, data sources and constraints a device chooses to share.',
    observeTitle: 'Observe',
    observeCopy: 'Give an agent fresh device state and observations when it needs to decide.',
    coordinateTitle: 'Coordinate',
    coordinateCopy: 'Request work across instruments, robots and vision systems in one task.',
    safetyTitle: 'Safety stays where it belongs',
    safetyCopy:
      'Controllers retain interlocks, emergency stops and real-time control. MHS asks; the device decides what it can safely do.',
    robotTitle: 'Precision motion, orchestrated',
    robotCopy:
      'An agent observes the workcell, chooses the next operation and requests robotic execution through MHS.',
    contactEyebrow: 'READY TO CONNECT',
    contactTitle: 'Let’s connect.',
    contactLead:
      'Bring your device interface, control boundaries and first workflow. We’ll map a practical MHS pilot together.',
    overview: 'Overview',
    workflow: 'How it works',
    previous: 'Previous',
    next: 'Next',
    pages: 'MHS pages',
    name: 'Name / Company / Organization',
    phone: 'Phone number',
    callingCode: 'Country / region code',
    requestType: 'Inquiry type',
    chooseType: 'Select an inquiry type',
    'request.tech': 'Tech Consulting',
    'request.business': 'Business Cooperation',
    'request.deployment': 'On-Premises Deployment',
    'request.other': 'Other',
    otherDetails: 'Please specify',
    github: 'GitHub Links',
    optional: '(optional)',
    prepare: 'Prepare inquiry email',
    formHelp: 'Opens your email app with the details below. Review and send the email yourself.',
    draftOpened:
      'Email app requested. Review the draft and send it manually. No email has been sent by Harness.',
    subject: 'MHS sales inquiry',
  },
  'zh-CN': {
    brand: 'MHS',
    byline: 'by Agnes',
    robotics: 'MHS / 机械臂',
    hub: 'AGNES HUB',
    eyebrow: 'MODEL HARDWARE STANDARD',
    titleFirst: '让智能，',
    titleSecond: '触达真实世界。',
    heroPreviewCopy: '机械臂 · 案例演示',
    lead: 'MHS 为智能体提供统一、可信的设备接口：发现设备能力、读取实时状态，并编排跨设备任务。',
    contact: '联系销售',
    proofOne: '设备原生能力',
    proofTwo: '执行过程可见',
    proofThree: '面向多设备协同',
    architectureFirst: '统一接入，',
    architectureSecond: '让设备各展所长。',
    architectureKicker: '如何工作',
    architectureLead: 'MHS 将 AI 工作流连接到设备已有的能力之上，而不是让智能体成为实时控制器。',
    discoverTitle: '发现能力',
    discoverCopy: '呈现设备愿意共享的工具、数据源和约束条件。',
    observeTitle: '读取观测',
    observeCopy: '在需要决策时，为智能体提供最新的设备状态与观测信息。',
    coordinateTitle: '协同执行',
    coordinateCopy: '在同一项任务中请求仪器、机器人与视觉系统协同工作。',
    safetyTitle: '安全，留在它该在的位置',
    safetyCopy: '控制器仍负责联锁、急停与实时控制。MHS 发起请求；设备决定哪些操作可以安全执行。',
    robotTitle: '精确运动，统一编排',
    robotCopy: '智能体观察工作单元、选择下一步操作，再通过 MHS 请求机械臂执行。',
    contactEyebrow: '准备连接',
    contactTitle: '让连接，从这里开始。',
    contactLead: '带上设备接口、控制边界和第一个工作流；我们一起规划可落地的 MHS 试点。',
    overview: '产品概览',
    workflow: '能力流程',
    previous: '上一页',
    next: '下一页',
    pages: 'MHS 页面',
    name: '姓名/公司/组织名称',
    phone: '联系方式（手机号）',
    callingCode: '国家/地区区号',
    requestType: '需求类型',
    chooseType: '请选择需求类型',
    'request.tech': '技术咨询',
    'request.business': '商业合作',
    'request.deployment': '私有化部署',
    'request.other': '其他',
    otherDetails: '请填写具体需求类型',
    github: 'GitHub链接',
    optional: '（选填）',
    prepare: '生成咨询邮件',
    formHelp: '点击后将打开您的邮件客户端并预填咨询内容，请核对后手动发送。',
    draftOpened: '已请求打开邮件客户端，请在草稿中核对并手动发送。Harness 未自动发送邮件。',
    subject: 'MHS 销售咨询',
  },
}

export function MhsPage({ context }: { context: UiExtensionContext }) {
  const { t, locale } = useUiText(MHS_NAMESPACE, mhsCatalog)
  const [slide, setSlide] = useState(0)
  const [draftOpened, setDraftOpened] = useState(false)
  const [callingCode, setCallingCode] = useState(() => (locale === 'zh-CN' ? '+86' : '+1'))
  const [requestType, setRequestType] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const language = locale === 'zh-CN' ? 'zh' : 'en'
  const mediaOrigin =
    locale === 'zh-CN' ? 'https://cos-agent-default.agnes-ai.cn' : 'https://cos-agent-default.agnes-ai.com'
  const salesEmail = locale === 'zh-CN' ? 'support@agnes-ai.cn' : 'support@agnes-ai.com'
  const labels = [t('overview'), t('workflow'), t('contact')]
  const go = (next: number) => {
    if (next === slide) return
    video.current?.pause()
    setSlide(next)
    panel.current?.scrollTo({ top: 0 })
  }
  useEffect(() => {
    if (slide !== 0) video.current?.pause()
  }, [slide])
  const prepareEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (key: string) => String(form.get(key) ?? '').trim()
    const fields = [
      [t('name'), value('name')],
      [t('phone'), value('callingCode') + ' ' + value('phone')],
      [t('requestType'), t('request.' + value('requestType'))],
      ...(value('requestType') === 'other' ? [[t('otherDetails'), value('otherDetails')]] : []),
      ...(value('github') ? [[t('github'), value('github')]] : []),
    ]
    const body = fields.map(([label, content]) => label + ': ' + content).join('\n\n')
    window.location.href =
      'mailto:' +
      salesEmail +
      '?subject=' +
      encodeURIComponent(t('subject')) +
      '&body=' +
      encodeURIComponent(body)
    setDraftOpened(true)
  }
  return (
    <article
      className="mhs-page mhs-deck"
      data-testid="home-page-mhs"
      aria-label={context.t('home.entry.mhs')}
    >
      <nav className="mhs-topnav" aria-label={t('pages')}>
        <Button appearance="ghost" htmlType="button" onClick={() => go(0)}>
          <span className="mhs-wordmark">
            <Icon name="route" /> {t('brand')}
            <span>{t('byline')}</span>
          </span>
        </Button>
        <div className="mhs-deck-links">
          {labels.map((label, index) => (
            <Button
              appearance={index === 2 ? 'primary' : slide === index ? 'secondary' : 'ghost'}
              key={label}
              htmlType="button"
              className={index === 2 ? 'mhs-sales-link' : ''}
              aria-current={slide === index ? 'page' : undefined}
              aria-controls={`mhs-slide-${index}`}
              onClick={() => go(index)}
            >
              {label}
            </Button>
          ))}
        </div>
      </nav>
      <div className="mhs-deck-stage">
        {slide > 0 && (
          <IconButton
            appearance="secondary"
            name="arrow-left"
            label={t('previous')}
            className="mhs-page-arrow mhs-page-arrow-left"
            htmlType="button"
            onClick={() => go(slide - 1)}
          />
        )}
        <div ref={panel} className="mhs-deck-viewport">
          <div className={`mhs-deck-panel mhs-deck-panel-${slide}`}>
            <section
              className="mhs-hero mhs-slide"
              id="mhs-slide-0"
              aria-label={t('overview')}
              hidden={slide !== 0}
            >
              <div className="mhs-hero-copy">
                <p className="mhs-eyebrow">{t('eyebrow')}</p>
                <h1>
                  <span>{t('titleFirst')}</span>
                  <span>{t('titleSecond')}</span>
                </h1>
                <p className="mhs-lead">{t('lead')}</p>
                <div className="mhs-actions">
                  <Button appearance="primary" htmlType="button" onClick={() => go(2)}>
                    {t('contact')} <Icon name="arrow-right" />
                  </Button>
                  <Button appearance="secondary" htmlType="button" onClick={() => go(1)}>
                    {t('workflow')} <Icon name="arrow-right" />
                  </Button>
                </div>
                <ul className="mhs-proof" aria-label={t('eyebrow')}>
                  {[t('proofOne'), t('proofTwo'), t('proofThree')].map((item) => (
                    <li key={item}>
                      <span aria-hidden="true">✦</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mhs-hero-demo">
                <div className="mhs-flow-heading">
                  <span>{t('robotics')}</span>
                  <span>{t('heroPreviewCopy')}</span>
                </div>
                {/* Supplied localized recordings include subtitles in the video image. */}
                {/* biome-ignore lint/a11y/useMediaCaption: the supplied recordings have burned-in localized subtitles. */}
                <video
                  ref={video}
                  key={language}
                  controls
                  playsInline
                  preload="metadata"
                  poster={`${mediaOrigin}/mhs/robot-arm-${language}.png`}
                  aria-label={t('robotTitle')}
                >
                  <source src={`${mediaOrigin}/mhs/robot-arm-${language}.mp4`} type="video/mp4" />
                </video>
                <div className="mhs-hero-demo-copy">
                  <h3>{t('robotTitle')}</h3>
                  <p>{t('robotCopy')}</p>
                </div>
              </div>
            </section>
            <section
              className="mhs-story mhs-slide"
              id="mhs-slide-1"
              aria-label={t('workflow')}
              hidden={slide !== 1}
            >
              <div className="mhs-story-heading">
                <div>
                  <p className="mhs-eyebrow">{t('architectureKicker')}</p>
                  <h2>
                    {t('architectureFirst')}
                    <br />
                    <span>{t('architectureSecond')}</span>
                  </h2>
                </div>
                <p>{t('architectureLead')}</p>
              </div>
              <div className="mhs-flow-panel">
                <div className="mhs-flow-heading">
                  <span>{t('brand')}</span>
                  <span aria-hidden="true">
                    {t('hub')} <Icon name="arrow-right" />
                  </span>
                </div>
                <div className="mhs-steps">
                  {steps.map(([number, title, copy, icon]) => (
                    <article className="mhs-step" key={number}>
                      <div className={`mhs-step-visual mhs-step-visual-${number}`} aria-hidden="true">
                        <span className="mhs-step-halo" />
                        <span className="mhs-step-symbol">
                          <Icon name={icon} />
                        </span>
                        <span className="mhs-step-satellite mhs-step-satellite-a" />
                        <span className="mhs-step-satellite mhs-step-satellite-b" />
                        <span className="mhs-step-satellite mhs-step-satellite-c" />
                      </div>
                      <span className="mhs-step-number">{number} /</span>
                      <h3>{t(title)}</h3>
                      <p>{t(copy)}</p>
                    </article>
                  ))}
                </div>
                <aside className="mhs-safety">
                  <Icon name="route" />
                  <div>
                    <strong>{t('safetyTitle')}</strong>
                    <p>{t('safetyCopy')}</p>
                  </div>
                </aside>
              </div>
            </section>

            <section
              className="mhs-contact mhs-slide"
              id="mhs-slide-2"
              aria-label={t('contact')}
              hidden={slide !== 2}
            >
              <div className="mhs-contact-copy">
                <p className="mhs-eyebrow">{t('contactEyebrow')}</p>
                <h2>{t('contactTitle')}</h2>
                <p>{t('contactLead')}</p>
                <a className="mhs-direct-email" href={`mailto:${salesEmail}`}>
                  <Icon name="send" />
                  {salesEmail}
                </a>
                <p className="mhs-mail-help">{t('formHelp')}</p>
              </div>
              <form className="mhs-inquiry" onSubmit={prepareEmail}>
                <label htmlFor="mhs-name">
                  {t('name')} *
                  <SettingsInput id="mhs-name" name="name" required maxLength={200} />
                </label>
                <div className="mhs-phone-field">
                  <label htmlFor="mhs-phone">{t('phone')} *</label>
                  <div className="mhs-phone-inputs">
                    <div className="mhs-code-picker">
                      <SettingsSelect
                        name="callingCode"
                        aria-label={t('callingCode')}
                        autoComplete="tel-country-code"
                        value={callingCode}
                        onChange={(event) => setCallingCode(event.target.value)}
                      >
                        {callingCodes.map(([code, en, zh]) => (
                          <option key={code} value={code}>
                            {code} {locale === 'zh-CN' ? zh : en}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    <SettingsInput
                      id="mhs-phone"
                      name="phone"
                      type="tel"
                      autoComplete="tel-national"
                      required
                      pattern="[0-9][0-9 ()-]{3,24}"
                      maxLength={25}
                    />
                  </div>
                </div>
                <label htmlFor="mhs-request-type">
                  {t('requestType')} *
                  <SettingsSelect
                    id="mhs-request-type"
                    name="requestType"
                    required
                    value={requestType}
                    onChange={(event) => {
                      setRequestType(event.target.value)
                      setDraftOpened(false)
                    }}
                  >
                    <option value="" disabled>
                      {t('chooseType')}
                    </option>
                    {requestTypes.map((type) => (
                      <option key={type} value={type}>
                        {t(`request.${type}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                </label>
                {requestType === 'other' && (
                  <label htmlFor="mhs-other-details">
                    {t('otherDetails')} *
                    <SettingsInput id="mhs-other-details" name="otherDetails" required maxLength={500} />
                  </label>
                )}
                <label htmlFor="mhs-github">
                  {t('github')} {t('optional')}
                  <SettingsInput
                    id="mhs-github"
                    name="github"
                    type="url"
                    placeholder="https://github.com/…"
                    maxLength={500}
                  />
                </label>
                <Button appearance="primary" htmlType="submit">
                  {t('prepare')} <Icon name="arrow-right" />
                </Button>
                {draftOpened && (
                  <p className="mhs-mail-status" role="status">
                    {t('draftOpened')}
                  </p>
                )}
              </form>
            </section>
          </div>
        </div>
        {slide < 2 && (
          <IconButton
            appearance="secondary"
            name="arrow-right"
            label={t('next')}
            className="mhs-page-arrow mhs-page-arrow-right"
            htmlType="button"
            onClick={() => go(slide + 1)}
          />
        )}
      </div>
      <footer className="mhs-pagination">
        <div aria-live="polite">
          <span>0{slide + 1} / 03</span>
          <strong>{labels[slide]}</strong>
        </div>
      </footer>
    </article>
  )
}
