import {
  createCatalogTranslator,
  type LocaleCatalog,
  type LocaleTranslator,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { useMemo } from 'react'

export const VOICE_LOCALE_NAMESPACE = '@agnes/web/voice'

export const voiceLocaleCatalog: LocaleCatalog = {
  en: {
    'voice.mic': 'Dictate',
    'voice.micStop': 'Stop and transcribe',
    'voice.wave': 'Voice conversation',
    'voice.waveStop': 'End voice conversation',
    'voice.read': 'Read',
    'voice.stop': 'Stop',
    'voice.clickToPlay': 'Click to play',
    'voice.seconds': '{seconds}s',
    'voice.phase.listening': 'Listening',
    'voice.phase.transcribing': 'Transcribing',
    'voice.phase.thinking': 'Thinking',
    'voice.phase.reading': 'Reading',
    'voice.reason.no-account': 'No voice account yet',
    'voice.reason.credential-missing': 'The voice account has no key',
    'voice.reason.ambiguous': 'There are several voice accounts; choose one in settings',
    'voice.reason.no-model': 'The voice account has no recognition (reading) model',
    'voice.reason.insecure-context': 'The microphone works only on localhost or https pages',
    'voice.reason.other-tab': 'Another tab is in a voice conversation',
    'voice.reason.offline': 'Voice is unavailable right now; check the connection',
    'voice.configure': 'Configure',
    'voice.notice.empty': "Didn't catch that, please say it again",
    'voice.notice.turn-ended': 'This turn ended without a reply',
    'voice.notice.failed': 'Voice failed, please try again',
    'voice.notice.mic-denied': 'Microphone access was denied; allow it in the browser',
    'voice.notice.session-failed': 'Could not open a session for the voice input',
  },
  'zh-CN': {
    'voice.mic': '说话',
    'voice.micStop': '停止并识别',
    'voice.wave': '语音对话',
    'voice.waveStop': '结束语音对话',
    'voice.read': '朗读',
    'voice.stop': '停止',
    'voice.clickToPlay': '点击播放',
    'voice.seconds': '{seconds} 秒',
    'voice.phase.listening': '在听',
    'voice.phase.transcribing': '识别中',
    'voice.phase.thinking': '在想',
    'voice.phase.reading': '在读',
    'voice.reason.no-account': '还没有语音账户',
    'voice.reason.credential-missing': '语音账户的密钥缺失',
    'voice.reason.ambiguous': '有多个语音账户，请在设置里选一个',
    'voice.reason.no-model': '语音账户没有识别（朗读）模型',
    'voice.reason.insecure-context': '话筒只在 localhost 或 https 页面可用',
    'voice.reason.other-tab': '另一个标签页正在语音对话',
    'voice.reason.offline': '语音暂时不可用，请检查连接',
    'voice.configure': '去配置',
    'voice.notice.empty': '没听清，请再说一次',
    'voice.notice.turn-ended': '这一轮没有回复',
    'voice.notice.failed': '语音出错了，请再试一次',
    'voice.notice.mic-denied': '话筒权限被拒绝，请在浏览器里允许',
    'voice.notice.session-failed': '没能为语音输入建立会话',
  },
}

/** The voice copy in the document's language: these buttons render inside host regions. */
export function useVoiceText(): LocaleTranslator {
  const language = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  return useMemo(() => createCatalogTranslator(voiceLocaleCatalog, language), [language])
}
