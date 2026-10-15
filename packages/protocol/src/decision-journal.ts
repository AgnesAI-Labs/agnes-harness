/** Reserved ledger namespace. These journals carry native decisions, never conversations. */
export const PROFILE_DECISION_JOURNAL_PREFIX = '@profile/'
export const isProfileDecisionJournal = (key: string): boolean =>
  key.startsWith(PROFILE_DECISION_JOURNAL_PREFIX)
export const profileDecisionJournalKey = (profileId: string): string =>
  `${PROFILE_DECISION_JOURNAL_PREFIX}${profileId}`
