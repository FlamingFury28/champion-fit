import { clampInteger, normalizeRole, ROLES } from './filters'
import { canonicalQueueFilter } from './queue-filter'
import { useRememberedFilters } from './remembered-filters'
import { useSearchParams } from 'react-router'
import { COMPETITIVE_PLAN_FILTERS_KEY, DEFAULT_PLAN_BUDGET, useRememberedPlanBudget } from './remembered-plan-budget'

export { COMPETITIVE_PLAN_FILTERS_KEY } from './remembered-plan-budget'
const defaults = { budget: String(DEFAULT_PLAN_BUDGET), role: '', queue: '', days: '' }
export const PLAN_QUEUES = ['420', '440', '400', '430', '490', '480', '700']

export function competitivePlanFilters(params: URLSearchParams) {
  return {
    budget: String(clampInteger(params.get('budget') ?? params.get('n'), 20, 2000, DEFAULT_PLAN_BUDGET)),
    role: params.has('role') ? normalizeRole(params.get('role')) : '',
    queue: canonicalQueueFilter(params.get('queue')) ?? '',
    days: params.get('days') ?? '',
  }
}

export function useCompetitivePlanFilters() {
  const [params] = useSearchParams()
  const sharedBudget = useRememberedPlanBudget(params)
  const remembered = useRememberedFilters({
    storageKey: COMPETITIVE_PLAN_FILTERS_KEY,
    defaults,
    aliases: ['n'],
    keepExplicitKeys: ['budget'],
    parse: competitivePlanFilters,
    validSavedValue: (key, value) => key === 'budget' ? /^\d+$/.test(value) && Number(value) >= 20 && Number(value) <= 2000
      : key === 'role' ? value === '' || ROLES.includes(value as typeof ROLES[number])
        : key === 'queue' ? value === '' || value === 'all' || PLAN_QUEUES.includes(value)
          : ['', '90', '180', '365', 'all'].includes(value),
  })
  return {
    ...remembered,
    filters: { ...remembered.filters, budget: String(sharedBudget.budget) },
    storageAvailable: remembered.storageAvailable && sharedBudget.storageAvailable,
    updateFilters: (update: Partial<typeof defaults>) => {
      if (update.budget !== undefined) sharedBudget.rememberBudget(Number(update.budget))
      // A filter edit materializes the displayed budget as part of its link.
      // Otherwise a remembered choice would silently revert to the link default.
      remembered.updateFilters({ budget: String(sharedBudget.budget), ...update })
    },
  }
}
