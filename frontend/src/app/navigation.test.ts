import { describe, expect, it } from 'vitest'
import { championHref, legacyDestination, sectionHref } from './navigation'

const url = (value: string) => new URL(value, 'http://localhost')

describe('canonical navigation', () => {
  it('opens a shareable champion sheet without changing list filters', () => {
    const filters = new URLSearchParams('role=TOP&search=Ahri&section=choices&status=validated')
    const target = url(championHref('Ahri', 'MIDDLE', filters))
    expect(target.pathname).toBe('/app/fit')
    expect(Object.fromEntries(target.searchParams)).toEqual({ role: 'TOP', search: 'Ahri', section: 'choices', status: 'validated', detail: 'Ahri', detailRole: 'MIDDLE' })
    expect(filters.has('detail')).toBe(false)
  })

  it('opens an unscoped champion sheet in the competitive performance area', () => {
    const target = url(championHref('Ahri', 'MIDDLE'))
    expect(target.searchParams.get('section')).toBe('best')
    expect(target.searchParams.get('detail')).toBe('Ahri')
  })

  it('switches a section without carrying an open sheet or erasing filters', () => {
    const target = url(sectionHref('/app/fit', 'training', new URLSearchParams('section=choices&role=MIDDLE&n=100&detail=Ahri&detailRole=TOP')))
    expect(Object.fromEntries(target.searchParams)).toEqual({ section: 'training', role: 'MIDDLE', n: '100' })
  })

  it.each([
    ['/app/champions', '?role=TOP', '/app/fit', { section: 'matchups', relation: 'enemies', role: 'TOP' }],
    ['/app/team/synergy', '?champion=Ahri&min_reliability=reliable', '/app/fit', { section: 'matchups', relation: 'allies', champion: 'Ahri', min_reliability: 'reliable' }],
    ['/app/test-plan', '?n=100&role=MIDDLE', '/app/fit', { section: 'training', training: 'plan', n: '100', role: 'MIDDLE' }],
    ['/app/scout', '', '/app/fit', { section: 'training', training: 'discover' }],
    ['/app/review/blacklist', '', '/app/fit', { section: 'choices', decision: 'pause' }],
    ['/app/playstyles', '?days=90&queue=420&category=mage', '/app/matches', { section: 'style', days: '90', queue: '420', category: 'mage' }],
    ['/app/review/audit', '', '/app/matches', { section: 'history', flag: 'contaminated' }],
    ['/app/review/audit', '?flag=all', '/app/matches', { section: 'history', flag: 'all' }],
  ])('preserves the meaning of %s%s', (path, search, expectedPath, expectedParams) => {
    const target = url(legacyDestination(path, search)!)
    expect(target.pathname).toBe(expectedPath)
    expect(Object.fromEntries(target.searchParams)).toEqual(expectedParams)
  })

  it('keeps a champion bookmark on the selected champion and role', () => {
    const target = url(legacyDestination('/app/champions/Cho%27Gath', '?role=TOP')!)
    expect(target.searchParams.get('detail')).toBe("Cho'Gath")
    expect(target.searchParams.get('detailRole')).toBe('TOP')
  })

  it.each([
    ['/index.html', '?account=Alpha%23EUW', '/app/overview', { account: 'Alpha#EUW' }],
    ['/fit.html', '?account=Alpha%23EUW&role=MIDDLE', '/app/fit', { account: 'Alpha#EUW', role: 'MIDDLE', section: 'best' }],
    ['/profile.html', '?account=Alpha%23EUW', '/app/profile', { account: 'Alpha#EUW' }],
    ['/friends.html', '?queue=420', '/app/team/friends', { queue: '420' }],
    ['/synergy.html', '?champion=Ahri', '/app/fit', { champion: 'Ahri', section: 'matchups', relation: 'allies' }],
    ['/allocation.html', '?n=100', '/app/fit', { n: '100', section: 'training', training: 'plan' }],
    ['/blacklist.html', '', '/app/fit', { section: 'choices', decision: 'pause' }],
    ['/audit.html', '?flag=all', '/app/matches', { flag: 'all', section: 'history' }],
    ['/scout.html', '?role=TOP', '/app/fit', { role: 'TOP', section: 'training', training: 'discover' }],
  ])('preserves the meaning of an old page %s%s', (path, search, expectedPath, expectedParams) => {
    const target = url(legacyDestination(path, search)!)
    expect(target.pathname).toBe(expectedPath)
    expect(Object.fromEntries(target.searchParams)).toEqual(expectedParams)
  })

  it('translates old champion query bookmarks and removes the legacy parameter names', () => {
    const target = url(legacyDestination('/champion.html', '?champion=Cho%27Gath&role=TOP&account=Alpha%23EUW')!)
    expect(target.pathname).toBe('/app/fit')
    expect(Object.fromEntries(target.searchParams)).toEqual({
      account: 'Alpha#EUW', section: 'best', detail: "Cho'Gath", detailRole: 'TOP',
    })
  })

  it('preserves legacy screening bookmarks when opening the old fit page directly', () => {
    const target = url(legacyDestination('/fit.html', '?status=screen&search=Annie&account=Alpha%23EUW')!)
    expect(target.pathname).toBe('/app/fit')
    expect(Object.fromEntries(target.searchParams)).toEqual({
      search: 'Annie', account: 'Alpha#EUW', section: 'training', training: 'discover',
    })
  })

  it('redirects old screening filters once and leaves canonical URLs alone', () => {
    const target = legacyDestination('/app/fit', '?status=screen&search=Annie')!
    expect(url(target).searchParams.get('section')).toBe('training')
    expect(url(target).searchParams.get('search')).toBe('Annie')
    expect(legacyDestination('/app/fit', url(target).search)).toBeNull()
    const explicit = legacyDestination('/app/fit', '?section=choices&status=screen&search=Annie')!
    expect(url(explicit).searchParams.get('section')).toBe('training')
    expect(url(explicit).searchParams.get('training')).toBe('discover')
    expect(legacyDestination('/app/matches', '')).toBeNull()
  })
})
