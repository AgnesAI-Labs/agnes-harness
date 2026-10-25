/**
 * The closing line of every Core note that asks the model to do or write something (turn limits,
 * the measured turn time, a progress check, the unattended-run and child-receipt notes). The notes
 * are English; without a language line a model answering one tended to switch its working language
 * to the note's, or to another, mid-task. This wording names no language: it is the fallback for a
 * prompt whose language `promptLanguage` cannot tell.
 */
export const NOTE_LANGUAGE = 'Keep working and replying in the language the user and the task use.'

/**
 * The language line naming the language the user wrote in. A rule that names no language leaves the
 * model to decide which language "the user" uses, and the newest user-role message it sees is often
 * an English Core note, not the user; in English tasks such a rule coincided with final replies in
 * the model's own default language. Naming the language leaves nothing to decide.
 */
export const noteLanguageLine = (language?: string): string =>
  language ? `The user writes in ${language}; keep working and replying in ${language}.` : NOTE_LANGUAGE

/** A Core note's text with its closing language line. */
export const withNoteLanguage = (text: string, language?: string): string =>
  `${text}\n${noteLanguageLine(language)}`

/**
 * Common English function words, leaving out those other Latin-script languages share (`a`, `in`,
 * `on`, `was`): a Latin-script prompt that uses them is taken as English.
 */
const ENGLISH_WORDS = new Set(
  'and are at be but by can do does for from has have how if into is it its make not of should that the their them then there these this to use were what when where which while why with you your'.split(
    ' ',
  ),
)

/**
 * The language a prompt is written in, read from its script alone (no model call): Chinese,
 * Japanese, Korean or English, or none when the prompt is empty, mixed or in another language, so
 * the caller falls back to `NOTE_LANGUAGE`. Code, fenced or inline, is skipped: it is not prose, and
 * a Chinese request that pastes an English log is still a Chinese request.
 */
export function promptLanguage(text: string): string | undefined {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0
  const kana = prose.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0
  const hangul = prose.match(/\p{Script=Hangul}/gu)?.length ?? 0
  const words = prose.match(/\p{Script=Latin}+/gu) ?? []
  const cjk = han + kana + hangul
  if (cjk > 0) {
    // One CJK character carries about one Latin word's meaning; fewer than that is mixed.
    if (cjk < words.length) return undefined
    if (hangul > han + kana) return 'Korean'
    return kana > 0 ? 'Japanese' : 'Chinese'
  }
  if (words.length === 0 || /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(prose))
    return undefined
  const english = words.filter((word) => ENGLISH_WORDS.has(word.toLowerCase())).length
  return english > 0 && english * 10 >= words.length ? 'English' : undefined
}
