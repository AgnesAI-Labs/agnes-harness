import type { LocaleCatalog } from '@agnes/web-client'

export const toolCardsLocaleCatalog = {
  en: {
    'cards.question.title': 'Answer questions',
    'cards.question.invalid': 'Choose an answer for every question.',
    'cards.question.failed': 'Answer could not be submitted. Try again.',
    'cards.question.freeText': 'Free text',
    'cards.question.answered': 'Answered',
    'cards.question.submitting': 'Submitting…',
    'cards.question.submit': 'Submit answer',
    'cards.file.unavailable': 'File is unavailable',
    'cards.file.loading': 'Loading file…',
    'cards.file.title': 'Deliverable',
    'cards.file.open': 'Open',
    'cards.file.download': 'Download',
  },
  'zh-CN': {
    'cards.question.title': '回答问题',
    'cards.question.invalid': '请回答每个问题。',
    'cards.question.failed': '答案提交失败，请重试。',
    'cards.question.freeText': '自由填写',
    'cards.question.answered': '已回答',
    'cards.question.submitting': '正在提交…',
    'cards.question.submit': '提交答案',
    'cards.file.unavailable': '文件不可用',
    'cards.file.loading': '正在加载文件…',
    'cards.file.title': '交付物',
    'cards.file.open': '打开',
    'cards.file.download': '下载',
  },
} satisfies LocaleCatalog
