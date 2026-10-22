import { canonicalRole } from './filters'

/** Canonical destinations shared by navigation, contextual links and old bookmarks. */
export const destinations = {
  overview: '/app/overview',
  champions: '/app/fit',
  matches: '/app/matches',
  companions: '/app/team/friends',
  data: '/app/profile',
  algorithmSettings: '/app/settings/algorithms',
  siteMap: '/app/map',
} as const

export const legacyPagePaths = [
  '/index.html', '/fit.html', '/champion.html', '/profile.html', '/friends.html',
  '/synergy.html', '/allocation.html', '/blacklist.html', '/audit.html', '/scout.html',
] as const

export function withParams(path: string, params: URLSearchParams) {
  return `${path}${params.size ? `?${params.toString()}` : ''}`
}

export function withoutChampionDetail(params: URLSearchParams) {
  const next = new URLSearchParams(params)
  for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) next.delete(key)
  return next
}

export interface ResolvedRecommendationContext {
  readonly role: string
  readonly queue: string
}

export function sectionHref(path: string, section: string, params: URLSearchParams, context?: ResolvedRecommendationContext) {
  const next = withoutChampionDetail(params)
  if (path === destinations.champions
    && ['choices', 'training'].includes(params.get('section') ?? '')
    && ['best', 'tournament', 'matchups'].includes(section)) {
    const role = canonicalRole(params.get('role'))
    if (role === 'MID') next.set('role', 'MIDDLE')
    else if (role === 'ADC') next.set('role', 'BOTTOM')
    // The recommendation view treats this exact legacy token as all history.
    if (params.get('days') === '0') next.set('days', 'all')
    if (context) {
      next.set('role', context.role)
      next.set('queue', context.queue)
    }
  }
  next.set('section', section)
  return withParams(path, next)
}

export function championHref(champion: string, role: string, params = new URLSearchParams(), context?: { queue?: unknown; days?: unknown }) {
  const next = withoutChampionDetail(params)
  if (!['choices', 'best', 'tournament', 'matchups', 'training'].includes(next.get('section') ?? '')) next.set('section', 'best')
  next.set('detail', champion)
  next.set('detailRole', role || 'ALL')
  for (const [source, target] of [['queue', 'detailQueue'], ['days', 'detailDays']] as const) {
    const value = context?.[source]
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) {
      next.set(target, String(value))
    }
  }
  return withParams(destinations.champions, next)
}

export function legacyDestination(path: string, search: string): string | null {
  const params = new URLSearchParams(search)
  if (path === '/champion.html') {
    const champion = params.get('champion')?.trim()
    if (!champion) return withParams(destinations.champions, params)
    const role = params.get('role') || 'ALL'
    params.delete('champion')
    params.delete('role')
    return championHref(champion, role, params)
  }
  const routes: Record<string, [string, string | null, Record<string, string>?]> = {
    '/index.html': [destinations.overview, null],
    '/fit.html': [destinations.champions, 'best'],
    '/profile.html': [destinations.data, null],
    '/friends.html': [destinations.companions, null],
    '/synergy.html': [destinations.champions, 'matchups', { relation: 'allies' }],
    '/allocation.html': [destinations.champions, 'training', { training: 'plan' }],
    '/blacklist.html': [destinations.champions, 'choices', { decision: 'pause' }],
    '/audit.html': [destinations.matches, 'history', { flag: params.get('flag') || 'contaminated' }],
    '/scout.html': [destinations.champions, 'training', { training: 'discover' }],
    '/app/champions': [destinations.champions, 'matchups', { relation: 'enemies' }],
    '/app/team/synergy': [destinations.champions, 'matchups', { relation: 'allies' }],
    '/app/test-plan': [destinations.champions, 'training', { training: 'plan' }],
    '/app/scout': [destinations.champions, 'training', { training: 'discover' }],
    '/app/review/blacklist': [destinations.champions, 'choices', { decision: 'pause' }],
    '/app/playstyles': [destinations.matches, 'style'],
    '/app/review/audit': [destinations.matches, 'history', { flag: params.get('flag') || 'contaminated' }],
  }
  if (path.startsWith('/app/champions/')) {
    const encoded = path.slice('/app/champions/'.length)
    let champion = encoded
    try { champion = decodeURIComponent(encoded) } catch { /* Keep malformed links readable. */ }
    return championHref(champion, params.get('role') || 'ALL', params)
  }
  if ((path === destinations.champions || path === '/fit.html') && params.get('status') === 'screen' && (!params.has('section') || params.get('section') === 'choices')) {
    params.delete('status')
    params.set('section', 'training')
    params.set('training', 'discover')
    return withParams(destinations.champions, params)
  }
  const target = routes[path]
  if (!target) return null
  if (target[1]) params.set('section', target[1])
  Object.entries(target[2] ?? {}).forEach(([key, value]) => params.set(key, value))
  return withParams(target[0], params)
}
