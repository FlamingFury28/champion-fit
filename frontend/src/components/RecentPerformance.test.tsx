import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aggregateRecentPerformance, RecentPerformance, type RecentPerformanceMatch } from './RecentPerformance'
import { championSplashUrl } from './ChampionArtwork'

const observation = (date: string, win: 0 | 1, values: Partial<RecentPerformanceMatch> = {}): RecentPerformanceMatch => ({ date, win, account: 'Alpha#EUW', role: 'MIDDLE', ...values })

describe('aggregateRecentPerformance', () => {
  afterEach(() => vi.unstubAllEnvs())
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

  it('conserva le osservazioni canoniche degli anni 0001–0099 restituite dal server', () => {
    const dates = ['0001-01-01', '0004-02-29', '0099-12-31', '0100-01-01', '2026-09-01']
    const result = aggregateRecentPerformance(dates.map((date) => observation(`${date}T12:00:00Z`, 1, {
      date_utc: `${date}T12:00:00.000000+00:00`,
    })))

    expect(result.invalid).toBe(0)
    expect(result.days.map((day) => day.date)).toEqual(dates)
    expect(result.days.every((day) => Number.isFinite(day.timestamp) && day.wins === 1 && day.matches.length === 1)).toBe(true)
  })

  it('esclude ore che slittano al giorno dopo e istanti UTC fuori dall’intervallo del server', () => {
    const result = aggregateRecentPerformance([
      observation('2026-09-01T24:00:00Z', 1),
      observation('2026-09-01 24:00:00', 0),
      observation('0000-01-01T12:00:00Z', 1),
      observation('0001-01-01T00:30:00+01:00', 1),
      observation('9999-12-31T23:30:00-01:00', 0),
    ])

    expect(result.invalid).toBe(5)
    expect(result.days).toEqual([])
  })

  it.each(['Europe/Rome', 'America/New_York'])('interpreta le date ISO senza offset come UTC anche nel fuso %s', (timezone) => {
    vi.stubEnv('TZ', timezone)
    const result = aggregateRecentPerformance([
      observation('2026-10-17T00:30:00', 1),
      observation('2026-10-17 23:30:00', 0),
    ])

    expect(result.invalid).toBe(0)
    expect(result.days.map(({ date, wins, matches }) => [date, wins, matches.length])).toEqual([
      ['2026-10-17', 1, 2],
    ])
  })

  it('usa date_utc per date compatte e week date, rispettando ordine e giorno canonici senza modificare la data originale', () => {
    const compact = observation('20261018T003000+0200', 0, { date_utc: '2026-10-17T22:30:00.000499+00:00' })
    const week = observation('2026-W42-6T00:30:00+02:00', 1, { date_utc: '2026-10-16T22:30:00.000000+00:00' })
    const result = aggregateRecentPerformance([compact, week])

    expect(result.invalid).toBe(0)
    expect(result.days.map(({ date, wins, matches }) => [date, wins, matches.length])).toEqual([
      ['2026-10-16', 1, 1], ['2026-10-17', 0, 1],
    ])
    expect(result.days[0]!.matches[0]!.date).toBe('2026-W42-6T00:30:00+02:00')
    expect(compact.date).toBe('20261018T003000+0200')
  })

  it('ripiega sulla data originale quando date_utc manca e non normalizza un calendario canonico impossibile', () => {
    const result = aggregateRecentPerformance([
      observation('2026-10-17T00:30:00', 1, { date_utc: null }),
      observation('2026-10-17T00:30:00Z', 1, { date_utc: '2026-02-30T00:30:00.000000+00:00' }),
    ])

    expect(result.invalid).toBe(1)
    expect(result.days.map(({ date, matches }) => [date, matches.length])).toEqual([['2026-10-17', 1]])
  })
})

describe('RecentPerformance', () => {
  it('mostra le partite con data sorgente compatta o week date quando il server fornisce date_utc', () => {
    render(<RecentPerformance matches={[
      observation('20261017T003000+0200', 1, { date_utc: '2026-10-16T22:30:00.000000+00:00', champion: 'Ahri' }),
      observation('2026-W42-6T013000+0200', 0, { date_utc: '2026-10-16T23:30:00.000000+00:00', champion: 'Lux' }),
    ]} />)

    expect(screen.getByRole('combobox', { name: 'Esamina un giorno' })).toHaveValue('2026-10-16')
    const details = screen.getByRole('list', { name: /Osservazioni del 16 ott 2026/ })
    expect(within(details).getByText(/Ahri/)).toBeVisible()
    expect(within(details).getByText(/Lux/)).toBeVisible()
    expect(screen.getByText(/1 vittoria e 1 sconfitta/)).toBeVisible()
    expect(screen.queryByText(/escluse.*data.*non validi/)).not.toBeInTheDocument()
  })
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
