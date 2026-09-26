import type { QueryClient, QueryKey } from '@tanstack/react-query'

export const ANNOTATION_DEPENDENCIES = new Set([
  'overview', 'profile', 'champions', 'champion', 'matchups', 'synergy', 'matches', 'blacklist', 'recommendation-evidence',
  'playstyles', 'playstyle-evidence',
  'recommendations',
])

export function isAnnotationDependency(queryKey: QueryKey) {
  return ANNOTATION_DEPENDENCIES.has(String(queryKey[1]))
}

export function invalidateAfterAnnotation(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ predicate: (query) => isAnnotationDependency(query.queryKey) })
}

export function invalidateAfterFriendGroup(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ['api', 'friends'] })
}
