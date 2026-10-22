import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import type { ScopeSnapshot } from '../api/client'
import { recommendationsQuery, type RecommendationFilters } from '../api/queries'
import { ROLES } from './filters'

export interface RecommendationNavigationContext {
  readonly role: typeof ROLES[number]
  readonly queue: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRole(value: unknown): value is RecommendationNavigationContext['role'] {
  return typeof value === 'string' && ROLES.some((role) => role === value)
}

function isQueue(value: unknown): value is string {
  if (value === 'all') return true
  if (typeof value !== 'string' || value === '' || /[^0-9]/.test(value)) return false
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 9999
}

/**
 * Read only the active REC list query. The source page remains its sole fetch
 * owner; this hook never builds a Query, adds an observer or changes options.
 * `filters` must be the exact result of recommendationListFilters for the
 * currently rendered source, including its empty-versus-undefined policy.
 */
export function useRecommendationNavigationContext(
  scope: ScopeSnapshot,
  filters: RecommendationFilters,
  scopeReady: boolean,
): RecommendationNavigationContext | null {
  const queryClient = useQueryClient()
  const options = recommendationsQuery(scope, filters)
  const queryHash = queryClient.defaultQueryOptions(options).queryHash
  const cache = queryClient.getQueryCache()

  const subscribe = useCallback((notify: () => void) => cache.subscribe((event) => {
    if (event.query.queryHash === queryHash) notify()
  }), [cache, queryHash])

  // Return the cached state object itself: its identity remains stable between
  // cache updates. React also rechecks this snapshot across subscription setup.
  // Unknown is intentional: a cached response still needs runtime validation.
  const getSnapshot = useCallback(() => cache.get<unknown>(queryHash)?.state, [cache, queryHash])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const revision = scope.algorithmRevision
  if (!scopeReady || typeof revision !== 'number' || !Number.isInteger(revision)
    || state?.status !== 'success' || state.fetchStatus !== 'idle'
    || state.isInvalidated || state.error !== null) return null

  const data = state.data
  if (!isRecord(data) || data.algorithm_revision !== revision || !isRecord(data.context)) return null
  const { role, queue } = data.context
  if (!isRole(role) || !isQueue(queue)) return null

  // Preserve accepted numeric spellings such as 00440; never clamp or trim.
  return { role, queue }
}
