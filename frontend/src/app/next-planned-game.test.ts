import { describe, expect, it } from 'vitest'
import type { TrainingProgress } from '../api/training-progress'
import { nextPlannedGame } from './next-planned-game'

const counts = (planned: number, remaining: number) => ({ planned, remaining, completed: planned - remaining, extra: 0 })
function item(champion: string, role: string, planned: number, remaining: number, account = 'Alpha#EUW') {
  return { champion, role, ...counts(planned, remaining), accounts: [{ account, ...counts(planned, remaining) }] }
}
function progress(items: TrainingProgress['items'], extra: Partial<TrainingProgress> = {}): TrainingProgress {
  const planned = items.reduce((total, entry) => total + entry.planned, 0)
  const remaining = items.reduce((total, entry) => total + entry.remaining, 0)
  return { id: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64), started_at: '2026-10-22T10:00:00Z',
    budget_total: planned, ...counts(planned, remaining), queue: '420', accounts: ['Alpha#EUW', 'Beta#EUW'],
    companions: [], companion_mode: '', unavailable_accounts: [], companion_unavailable: false, items, ...extra }
}

describe('prossima partita del piano seguito', () => {
  it('dà priorità al lavoro rimanente, non al budget iniziale o ai campioni completati', () => {
    const data = progress([item('Ahri', 'MIDDLE', 40, 1), item('Lux', 'SUPPORT', 10, 6), item('Vi', 'JUNGLE', 50, 0)])
    const original = JSON.stringify(data)
    expect(nextPlannedGame(data)).toEqual({ champion: 'Lux', role: 'SUPPORT', remaining: 6, account: 'Alpha#EUW', accountRemaining: 6 })
    expect(JSON.stringify(data)).toBe(original)
  })

  it('mantiene separati i ruoli e sceglie un account con partite ancora assegnate', () => {
    const support = { ...item('Lux', 'SUPPORT', 12, 7), accounts: [
      { account: 'Alpha#EUW', ...counts(6, 2) }, { account: 'Beta#EUW', ...counts(6, 5) },
    ] }
    expect(nextPlannedGame(progress([item('Lux', 'MIDDLE', 20, 4), support]))).toEqual({
      champion: 'Lux', role: 'SUPPORT', remaining: 7, account: 'Beta#EUW', accountRemaining: 5,
    })
  })

  it('risolve le parità nello stesso modo anche quando cambia l’ordine dei dati', () => {
    const data = progress([item('Zed', 'MIDDLE', 5, 4), item('Ahri', 'TOP', 5, 4),
      { ...item('Ahri', 'MIDDLE', 10, 4), accounts: [
        { account: 'Beta#EUW', ...counts(5, 2) }, { account: 'Alpha#EUW', ...counts(5, 2) },
      ] }])
    const first = nextPlannedGame(data)
    expect(first).toMatchObject({ champion: 'Ahri', role: 'MIDDLE', account: 'Alpha#EUW' })
    data.items.reverse().forEach((entry) => entry.accounts.reverse())
    expect(nextPlannedGame(data)).toEqual(first)
  })

  it.each([{ unavailable_accounts: ['Alpha#EUW'] }, { companion_unavailable: true }])('sospende il consiglio se i conteggi sono incompleti: %j', (extra) => {
    expect(nextPlannedGame(progress([item('Ahri', 'MIDDLE', 20, 20)], extra))).toBeNull()
  })

  it('non suggerisce altre partite a piano concluso o senza un account disponibile', () => {
    expect(nextPlannedGame(progress([item('Ahri', 'MIDDLE', 20, 0)]))).toBeNull()
    expect(nextPlannedGame(progress([item('Ahri', 'MIDDLE', 20, 20)], { accounts: [] }))).toBeNull()
    expect(nextPlannedGame(progress([]))).toBeNull()
  })
})
