import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { aggregateRecentPerformance, RecentPerformance, type RecentPerformanceMatch } from './RecentPerformance'
import { championSplashUrl } from './ChampionArtwork'

const observation = (date: string, win: 0 | 1, values: Partial<RecentPerformanceMatch> = {}): RecentPerformanceMatch => ({ date, win, account: 'Alpha#EUW', role: 'MIDDLE', ...values })

describe('aggregateRecentPerformance', () => {
  it('ordina le date effettive e aggrega gli esiti per giorno UTC senza riempire i giorni vuoti', () => {
    const result = aggregateRecentPerformance([
      observation('2026-09-08T12:00:00Z', 0),
      observation('2026-09-01T23:30:00-02:00', 1),
      observation('2026-09-02T09:00:00Z', 0),
      observation('2026-09-01', 1),
    ])
    expect(result.days.map(({ date, wins, matches }) => [date, wins, matches.length])).toEqual([
      ['2026-09-01', 1, 1], ['2026-09-02', 1, 2], ['2026-09-08', 0, 1],
    ])
    expect(result.days[1]!.timestamp - result.days[0]!.timestamp).toBe(86_400_000)
    expect(result.days[2]!.timestamp - result.days[1]!.timestamp).toBe(6 * 86_400_000)
  })

  it('esclude solo duplicati identificabili dello stesso account senza inventare identità dalla data', () => {
    const first = observation('2026-09-01', 1, { match_id: 'EUW1-001' })
    const sameDateWithoutId = observation('2026-09-01', 0)
    const result = aggregateRecentPerformance([first, first, { ...first, account: 'Beta#EUW' }, sameDateWithoutId, sameDateWithoutId])
    expect(result.duplicates).toBe(1)
    expect(result.withoutIdentity).toBe(2)
    expect(result.days[0]!.matches).toHaveLength(4)
    expect(result.days[0]!.wins).toBe(2)
  })

  it('non normalizza date impossibili e non converte esiti malformati in vittorie', () => {
    const result = aggregateRecentPerformance([
      observation('data mancante', 1), observation('2026-02-30', 1), observation('2026-13-01', 0),
      observation('2026-09-01', 2 as 1), observation('2026-09-02', 0),
    ])
    expect(result.invalid).toBe(4)
    expect(result.days).toHaveLength(1)
    expect(result.days[0]!.wins).toBe(0)
  })
})

describe('RecentPerformance', () => {
  it('in modalità compatta mantiene i limiti visibili e rivela la selezione giornaliera su richiesta', async () => {
    const user = userEvent.setup()
    render(<RecentPerformance compact matches={[
      observation('2026-09-08', 0, { account: 'Beta#EUW' }),
      observation('2026-09-01', 1, { champion: 'Ahri' }),
    ]} />)
    const summary = screen.getByText('Esamina giornate e partite')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByRole('combobox', { name: 'Esamina un giorno' })).not.toBeVisible()
    expect(screen.getByText(/una finestra limitata dello storico/)).toBeVisible()
    expect(screen.getByText(/una partita condivisa può comparire più volte/)).toBeVisible()
    await user.tab()
    expect(summary).toHaveFocus()
    // jsdom does not emulate the summary element's native Enter activation.
    await user.click(summary)
    expect(summary.closest('details')).toHaveAttribute('open')
    const select = screen.getByRole('combobox', { name: 'Esamina un giorno' })
    await user.selectOptions(select, '2026-09-01')
    expect(screen.getByRole('list', { name: /Osservazioni del 1 set 2026/ })).toBeVisible()
    expect(screen.getByText(/Ahri/)).toBeVisible()
    await user.click(summary)
    expect(select).not.toBeVisible()
    expect(screen.getByText(/una partita condivisa può comparire più volte/)).toBeVisible()
  })

  it('rende selezionabile un giorno con controllo nativo e mostra gli esiti corrispondenti', async () => {
    const user = userEvent.setup()
    render(<RecentPerformance matches={[
      observation('2026-09-08', 0, { account: 'Beta#EUW' }),
      observation('2026-09-01', 1, { champion: 'Ahri' }),
      observation('2026-09-01', 0, { champion: 'Lux' }),
    ]} />)
    const select = screen.getByRole('combobox', { name: 'Esamina un giorno' })
    await user.tab()
    expect(select).toHaveFocus()
    expect(screen.getByText('Beta#EUW')).toBeVisible()
    await user.selectOptions(select, '2026-09-01')
    const details = screen.getByRole('list', { name: /Osservazioni del 1 set 2026/ })
    expect(within(details).getByText(/Ahri/)).toBeVisible()
    expect(within(details).getByText(/Lux/)).toBeVisible()
    expect(screen.queryByText('Beta#EUW')).not.toBeInTheDocument()
    expect(screen.getByText(/1 vittoria e 1 sconfitta/)).toBeVisible()
    expect(screen.getByText(/una partita condivisa può comparire più volte/)).toBeVisible()
  })

  it('aggiorna la selezione al cambio dati e gestisce una sola data o nessuna osservazione valida', () => {
    const { rerender } = render(<RecentPerformance matches={[observation('2026-09-01', 1)]} />)
    expect(screen.getByText(/Un solo giorno disponibile/)).toBeVisible()
    rerender(<RecentPerformance matches={[observation('2026-09-08', 0, { account: 'Beta#EUW' })]} />)
    expect(screen.getByRole('combobox')).toHaveValue('2026-09-08')
    expect(screen.queryByText('Alpha#EUW')).not.toBeInTheDocument()
    rerender(<RecentPerformance matches={[observation('sconosciuta', 1)]} />)
    expect(screen.getByText(/Nessuna osservazione con data ed esito validi/)).toBeVisible()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText(/1 osservazione esclusa/)).toBeVisible()
  })
})

describe('canonical champion artwork source', () => {
  it('ricava la splash solo da un URL icona Data Dragon valido', () => {
    expect(championSplashUrl('https://ddragon.leagueoflegends.com/cdn/16.17.1/img/champion/MonkeyKing.png')).toBe('https://ddragon.leagueoflegends.com/cdn/img/champion/splash/MonkeyKing_0.jpg')
    expect(championSplashUrl('https://example.com/img/champion/Ahri.png')).toBeUndefined()
    expect(championSplashUrl('https://ddragon.leagueoflegends.com/other/Ahri.png')).toBeUndefined()
    expect(championSplashUrl('Wukong')).toBeUndefined()
    expect(championSplashUrl()).toBeUndefined()
  })
})
