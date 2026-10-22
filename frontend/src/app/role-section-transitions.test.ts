import { describe, expect, it } from 'vitest'
import { sectionHref } from './navigation'

function sourceParams(section: string | null, role: string | null) {
  const params = new URLSearchParams({
    training: 'plan', queue: 'RANKED_FLEX_SR', days: '0', search: ' Ahri ', relation: 'allies',
    account: 'Alpha#EUW', algorithm_revision: '4',
    detail: 'Ahri', detailRole: 'TOP', detailQueue: '420', detailDays: '90',
  })
  params.append('account', 'Beta#EUW')
  if (section !== null) params.set('section', section)
  if (role !== null) params.set('role', role)
  return params
}

describe('ruolo concreto passando dai suggerimenti alle analisi comuni', () => {
  it.each([
    { source: 'choices', target: 'best', raw: 'MID', expected: 'MIDDLE' },
    { source: 'training', target: 'tournament', raw: '\u0085 adc \u001f', expected: 'BOTTOM' },
    { source: 'training', target: 'matchups', raw: ' mid ', expected: 'MIDDLE' },
  ])('trasporta $raw da $source a $target senza ampliare il ruolo', ({ source, target, raw, expected }) => {
    const params = sourceParams(source, raw)
    const before = params.toString()
    const destination = new URL(sectionHref('/app/fit', target, params), 'http://localhost')
    expect(destination.pathname).toBe('/app/fit')
    expect(destination.searchParams.get('role')).toBe(expected)
    expect(destination.searchParams.get('section')).toBe(target)
    expect(destination.searchParams.get('days')).toBe('all')
    for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) expect(destination.searchParams.has(key)).toBe(false)
    for (const [key, value] of params) {
      if (!['section', 'role', 'days', 'detail', 'detailRole', 'detailQueue', 'detailDays', 'account'].includes(key)) {
        expect(destination.searchParams.get(key)).toBe(value)
      }
    }
    expect(destination.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(params.toString()).toBe(before)
  })

  it.each([null, '', 'ALL', 'AUTO', 'unknown', '\ufeffMID\ufeff', ' middle ', 'UTILITY'])(
    'mantiene il valore %j senza introdurre un’altra policy di ruolo', (role) => {
      const params = sourceParams('choices', role)
      const before = params.toString()
      const destination = new URL(sectionHref('/app/fit', 'best', params), 'http://localhost')
      expect(destination.searchParams.get('role')).toBe(role)
      expect(params.toString()).toBe(before)
    },
  )

  it.each([
    { source: 'choices', target: 'training', path: '/app/fit' },
    { source: 'best', target: 'tournament', path: '/app/fit' },
    { source: null, target: 'best', path: '/app/fit' },
    { source: 'choices', target: 'history', path: '/app/matches' },
  ])('mantiene MID fuori dal passaggio autorizzato $source → $target in $path', ({ source, target, path }) => {
    const params = sourceParams(source, 'MID')
    const before = params.toString()
    const destination = new URL(sectionHref(path, target, params), 'http://localhost')
    expect(destination.searchParams.get('role')).toBe('MID')
    expect(destination.searchParams.get('days')).toBe('0')
    expect(params.toString()).toBe(before)
  })

  it.each([
    { raw: '0', expected: 'all' },
    { raw: null, expected: null },
    { raw: '', expected: '' },
    { raw: 'all', expected: 'all' },
    { raw: ' 0 ', expected: ' 0 ' },
    { raw: '\ufeff0\ufeff', expected: '\ufeff0\ufeff' },
    { raw: 'unknown', expected: 'unknown' },
  ])('trasporta il periodo $raw senza confondere storico completo e omissione', ({ raw, expected }) => {
    const params = sourceParams('choices', null)
    if (raw === null) params.delete('days')
    else params.set('days', raw)
    const before = params.toString()
    const destination = new URL(sectionHref('/app/fit', 'best', params), 'http://localhost')
    expect(destination.searchParams.get('days')).toBe(expected)
    expect(destination.searchParams.has('days')).toBe(raw !== null)
    expect(destination.searchParams.has('role')).toBe(false)
    expect(params.toString()).toBe(before)
  })
})
