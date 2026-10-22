import { canonicalRole, ROLES } from './filters'
import { stripPythonWhitespace } from './python-text'
import { canonicalQueueFilter } from './queue-filter'

export function recommendationRoleFilter(value: string | null): string | undefined {
  const normalized = canonicalRole(value)
  const role = normalized === 'MID' ? 'MIDDLE' : normalized === 'ADC' ? 'BOTTOM' : normalized
  return role === 'AUTO' || (role !== 'ALL' && ROLES.includes(role as typeof ROLES[number])) ? role : undefined
}

export function recommendationQueueFilter(value: string | null): string | null {
  if (value === null || value === '') return value
  const mode = stripPythonWhitespace(value).toLowerCase()
  // Recommendations recognize these sentinels on the original input, before
  // queue aliases. A prefixed or internally spaced sentinel must stay invalid.
  if (mode === 'all') return 'all'
  if (mode === '' || mode === 'auto') return 'auto'
  const canonical = canonicalQueueFilter(value)
  return canonical !== null && /^[0-9]+$/.test(canonical) ? canonical : value
}

export function recommendationPeriodFilter(value: string | null): string | null {
  // Only this exact legacy token is accepted; spaced or case-folded inputs
  // must still reach the recommendation endpoint's period validation.
  return value === '0' ? 'all' : value
}

export function recommendationListFilters(params: URLSearchParams, source: 'choices' | 'training') {
  const queue = recommendationQueueFilter(params.get('queue'))
  const days = recommendationPeriodFilter(params.get('days'))
  // Preserve each source page's existing empty-value cache policy.
  return {
    role: recommendationRoleFilter(params.get('role')),
    queue: source === 'choices' ? queue || undefined : queue ?? undefined,
    days: source === 'choices' ? days || undefined : days ?? undefined,
  }
}
