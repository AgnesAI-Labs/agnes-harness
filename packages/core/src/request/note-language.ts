/**
 * The closing line of every Core note that asks the model to do or write something (turn limits,
 * the measured turn time, a progress check, the unattended-run and child-receipt notes). The notes
 * are English; without this line a model answering one tended to switch its working language to
 * the note's, or to another, mid-task. It names no language, so it holds for every task.
 */
export const NOTE_LANGUAGE = 'Keep working and replying in the language the user and the task use.'

/** A Core note's text with its closing language line. */
export const withNoteLanguage = (text: string): string => `${text}\n${NOTE_LANGUAGE}`
