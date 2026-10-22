import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { canonicalRole, ROLES } from './filters'
import { canonicalQueueFilter } from './queue-filter'

export const OVERVIEW_FILTERS_KEY = 'champion-fit:overview-filters:v1'
export const OVERVIEW_QUEUES = ['420', '440', '400', '430', '490', '480', '700']
export const OVERVIEW_PERIODS = ['90', '180', '365', 'all']
const keys = ['role', 'queue', 'days'] as const
type OverviewFilters = Record<typeof keys[number], string>
const defaults: OverviewFilters = { role: '', queue: '', days: '' }

function readSavedFilters(): { filters: OverviewFilters; storageAvailable: boolean } {
  let raw: string | null
  try { raw = localStorage.getItem(OVERVIEW_FILTERS_KEY) }
  catch { return { filters: defaults, storageAvailable: false } }
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    const value = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
    return { filters: {
      role: typeof value.role === 'string' && ROLES.includes(value.role as typeof ROLES[number]) ? value.role : '',
      queue: typeof value.queue === 'string' && ['all', ...OVERVIEW_QUEUES].includes(value.queue) ? value.queue : '',
      days: typeof value.days === 'string' && OVERVIEW_PERIODS.includes(value.days) ? value.days : '',
    }, storageAvailable: true }
  } catch { return { filters: defaults, storageAvailable: true } }
}

export function useOverviewFilters(preservedBudget?: number) {
  const [saved, setSaved] = useState(readSavedFilters)
  const [params, setParams] = useSearchParams()
  // A link describes its own context; omitted fields in an explicit link use
  // server defaults instead of inheriting another browser's saved selection.
  const hasLinkFilters = keys.some((key) => params.has(key))
  const filters = hasLinkFilters ? {
    role: canonicalRole(params.get('role')),
    queue: canonicalQueueFilter(params.get('queue')) ?? '',
    days: params.get('days') ?? '',
  } : saved.filters

  function updateFilters(update: Partial<OverviewFilters>) {
    const nextFilters = { ...filters, ...update }
    let storageAvailable = true
    try { localStorage.setItem(OVERVIEW_FILTERS_KEY, JSON.stringify(nextFilters)) }
    catch { storageAvailable = false }
    setSaved({ filters: nextFilters, storageAvailable })
    setParams((current) => {
      const next = new URLSearchParams(current)
      // Empty values explicitly select defaults, including after a reset.
      keys.forEach((key) => next.set(key, nextFilters[key]))
      if (preservedBudget !== undefined && !next.has('budget') && !next.has('n')) next.set('budget', String(preservedBudget))
      return next
    }, { replace: true })
  }

  return { filters, storageAvailable: saved.storageAvailable, updateFilters, resetFilters: () => updateFilters(defaults) }
}
