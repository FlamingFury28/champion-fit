import type { MatchHistoryFilters } from '../api/queries'
import { canonicalRole, ROLES } from './filters'
import { canonicalQueueFilter } from './queue-filter'
import { useRememberedFilters } from './remembered-filters'

export const MATCH_HISTORY_DEFAULTS: MatchHistoryFilters = { champion: '', role: 'ALL', queue: 'all', days: 'all' }
export const MATCH_HISTORY_QUEUES = ['420', '440', '400', '430', '490', '480', '700']
export const MATCH_HISTORY_PERIODS = ['all', '90', '180', '365']
export const MATCH_HISTORY_FILTERS_KEY = 'champion-fit:match-history-filters:v1'

export function matchHistoryFilters(params: URLSearchParams): MatchHistoryFilters {
  return {
    champion: params.get('champion') ?? '',
    role: canonicalRole(params.get('role')) || 'ALL',
    queue: canonicalQueueFilter(params.get('queue')) || 'all',
    days: params.get('days') || 'all',
  }
}

export function useMatchHistoryFilters() {
  return useRememberedFilters({
    storageKey: MATCH_HISTORY_FILTERS_KEY,
    defaults: MATCH_HISTORY_DEFAULTS,
    parse: matchHistoryFilters,
    validSavedValue: (key, value) => key === 'champion' ? value.length <= 100 && !value.includes('\0')
      : key === 'role' ? ROLES.includes(value as typeof ROLES[number])
        : key === 'queue' ? ['all', ...MATCH_HISTORY_QUEUES].includes(value)
          : MATCH_HISTORY_PERIODS.includes(value),
  })
}
