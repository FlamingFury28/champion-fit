import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { SynergyResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS, setSetting } from '../app/algorithm-settings'
import { SynergyPage } from './SynergyPage'

vi.mock('../app/scope', () => ({
  useScope: () => ({
    scope: { accounts: ['Alpha#EUW'], companion: null },
    state: { companion: null },
    scopeReady: true,
    availableAccounts: [{ account: 'Alpha#EUW' }],
    setAccounts: vi.fn(),
    clearCompanion: vi.fn(),
  }),
}))

function payload(overrides: Partial<SynergyResponseDto> = {}): SynergyResponseDto {
  return {
    champion: 'ALL', accounts: ['Alpha#EUW'], companion_filter_active: false,
    min_reliability: 'weak', include_exploratory: false, min_games: 1,
    games: 0, games_with_teammates: 0,
    coverage: { raw_games: 0, eligible_games: 0, analyzed_games: 0, games_with_roster: 0, roster_coverage: 0 },
    available_champions: [], better_with: [], worse_with: [],
    ...overrides,
  }
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function LocationProbe() {
  return <output aria-label="URL corrente">{useLocation().search}</output>
}

function renderSynergy(fetchImpl: typeof fetch, url = '/app/fit?section=matchups&relation=allies', meaningfulDelta?: number, evidence: Record<string, unknown> = {}) {
  const fetch = vi.fn(fetchImpl)
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = <MemoryRouter initialEntries={[url]}><SynergyPage embedded /><LocationProbe /></MemoryRouter>
  const configured = meaningfulDelta !== undefined || Object.keys(evidence).length > 0
  if (configured) {
    let settings = structuredClone(RECOMMENDED_ALGORITHM_SETTINGS)
    for (const [key, value] of Object.entries(evidence)) settings = setSetting(settings, `evidence.${key}`, value)
    if (meaningfulDelta !== undefined) settings = setSetting(settings, 'evidence.meaningful_delta', meaningfulDelta)
    client.setQueryData(queryKeys.algorithmSettings, { settings, revision: 1 })
  }
  render(<QueryClientProvider client={client}>{configured ? <AlgorithmSettingsProvider>{content}</AlgorithmSettingsProvider> : content}</QueryClientProvider>)
  return { fetch, user: userEvent.setup() }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('filtri delle sinergie', () => {
  it.each([
    { raw: 'UTILITY', expected: 'SUPPORT' },
    { raw: ' utility ', expected: 'SUPPORT' },
    { raw: '\u0085\u001c utility \u001f\u0085', expected: 'SUPPORT' },
    { raw: ' middle ', expected: 'MIDDLE' },
    { raw: 'MIDDLE', expected: 'MIDDLE' },
    { raw: 'SUPPORT', expected: 'SUPPORT' },
    { raw: ' all ', expected: 'ALL' },
    { raw: null, expected: 'ALL' },
    { raw: '', expected: 'ALL' },
    { raw: '   ', expected: 'ALL' },
    { raw: 'unknown', expected: 'ALL' },
    { raw: '\ufeffMIDDLE\ufeff', expected: 'ALL' },
  ])('allinea il ruolo del link $raw al controllo e alla richiesta senza riscrivere il link', async ({ raw, expected }) => {
    const params = new URLSearchParams({ section: 'matchups', relation: 'allies' })
    if (raw !== null) params.set('role', raw)
    const search = `?${params}`
    const { fetch } = renderSynergy(() => Promise.resolve(response(payload())), `/app/fit${search}`)

    await screen.findByText('Gli account selezionati non contengono partite analizzate')
    expect(screen.getByLabelText('Ruolo')).toHaveValue(expected)
    expect(new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams.get('role')).toBe(expected)
    expect(screen.getByLabelText('URL corrente')).toHaveTextContent(search)
  })

  it('rimuove il ruolo legacy del link solo quando si scelgono tutti i ruoli', async () => {
    const { fetch, user } = renderSynergy(() => Promise.resolve(response(payload())), '/app/fit?section=matchups&relation=allies&role=utility')
    await screen.findByText('Gli account selezionati non contengono partite analizzate')
    expect(screen.getByLabelText('Ruolo')).toHaveValue('SUPPORT')

    await user.selectOptions(screen.getByLabelText('Ruolo'), 'ALL')

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(new URL(String(fetch.mock.calls[1]?.[0]), 'http://localhost').searchParams.get('role')).toBe('ALL')
    expect(screen.getByLabelText('URL corrente')).not.toHaveTextContent('role=')
    expect(screen.getByLabelText('URL corrente')).toHaveTextContent('relation=allies')
  })

  it('mostra le soglie configurate e distingue il minimo decisionale dal filtro di visualizzazione', async () => {
    const item = {
      champion: 'Lux', icon_url: '', games: 30, unique_games: 15, decision_games: 15,
      wins: 18, losses: 12, win_rate: 60, posterior_win_rate: 58, baseline_win_rate: 50,
      posterior_lift_pp: 8, relative_delta_pp: 8, credible_lower_90: 44, credible_upper_90: 72,
      direction_confidence: 80, direction_probability: 80,
      probability_meaningful_advantage: 70, probability_meaningful_disadvantage: 4,
      effective_sample_size: 30, personal_effective_sample_size: 30,
      reliability: 'indicative' as const, actionable: false, prior_source: 'neutral_50', prior_games: 0,
    }
    renderSynergy(() => Promise.resolve(response(payload({ games: 30, min_games: 1, better_with: [item] }))), undefined, undefined,
      { display_min_games: 5, indicative_games: 12, min_games: 40 })
    expect(screen.getByRole('option', { name: 'Debole o migliore · almeno 5 esiti' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Indicativa o migliore · almeno 12 esiti' })).toBeInTheDocument()
    expect(screen.getByText('meno di 5 esiti · da confermare')).toBeInTheDocument()
    expect(await screen.findByText('Campione ridotto')).toBeInTheDocument()
    expect(screen.getByText('Il campione personale è di 15 partite; la soglia minima è 40.')).toBeInTheDocument()
    expect(screen.getByText(/30 partite osservate · 15.0 partite personali distinte · 30.0 totali a supporto/)).toBeInTheDocument()
  })

  it('mantiene il campione scelto mentre carica il nuovo risultato senza riusare il conteggio precedente', async () => {
    const { user } = renderSynergy((input) => new URL(String(input), 'http://localhost').searchParams.get('champion') === 'ALL'
      ? Promise.resolve(response(payload({ available_champions: [{ champion: 'Ahri', games: 12, icon_url: '' }] })))
      : new Promise<Response>(() => undefined))
    await screen.findByRole('option', { name: 'Ahri · 12 partite' })
    await user.selectOptions(screen.getByLabelText('Campione giocato'), 'Ahri')

    expect(screen.getByRole('status', { name: 'Caricamento' })).toBeVisible()
    expect(screen.getByLabelText('Campione giocato')).toHaveValue('Ahri')
    expect(screen.getByRole('option', { name: /^Ahri$/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /12 partite/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('URL corrente')).toHaveTextContent('champion=Ahri')
  })

  it('conserva il campione del link dopo un errore e permette di recuperare scegliendo tutti', async () => {
    const { fetch, user } = renderSynergy((input) => Promise.resolve(
      new URL(String(input), 'http://localhost').searchParams.get('champion') === 'Ahri'
        ? response({ error: 'Sinergie temporaneamente non disponibili.' }, 503)
        : response(payload()),
    ), '/app/fit?section=matchups&relation=allies&champion=Ahri')

    expect(await screen.findByRole('alert')).toHaveTextContent('Sinergie temporaneamente non disponibili.')
    expect(screen.getByLabelText('Campione giocato')).toHaveValue('Ahri')
    expect(screen.getByRole('option', { name: /^Ahri$/ })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Campione giocato'), 'ALL')

    await screen.findByText('Gli account selezionati non contengono partite analizzate')
    expect(screen.getByLabelText('Campione giocato')).toHaveValue('ALL')
    expect(screen.getByLabelText('URL corrente')).not.toHaveTextContent('champion=')
    expect(fetch.mock.calls.some(([input]) => new URL(String(input), 'http://localhost').searchParams.get('champion') === 'ALL')).toBe(true)
  })

  it.each([{ availableChampions: [] }, { availableChampions: [{ champion: 'Lux', games: 3, icon_url: '' }] }])('mantiene visibile una selezione assente dalle opzioni restituite: $availableChampions', async ({ availableChampions }) => {
    renderSynergy(() => Promise.resolve(response(payload({ champion: 'Ahri', available_champions: availableChampions }))), '/app/fit?section=matchups&relation=allies&champion=Ahri')
    await screen.findByText('Gli account selezionati non contengono partite analizzate')

    expect(screen.getByLabelText('Campione giocato')).toHaveValue('Ahri')
    expect(screen.getByRole('option', { name: /^Ahri$/ })).toBeInTheDocument()
  })

  it('usa l’opzione e il conteggio ricevuti senza duplicare il campione selezionato', async () => {
    renderSynergy(() => Promise.resolve(response(payload({ champion: 'Ahri', available_champions: [{ champion: 'Ahri', games: 12, icon_url: '' }] }))), '/app/fit?section=matchups&relation=allies&champion=Ahri')
    await screen.findByRole('option', { name: 'Ahri · 12 partite' })

    expect(screen.getByLabelText('Campione giocato')).toHaveValue('Ahri')
    expect(within(screen.getByLabelText('Campione giocato')).getAllByRole('option')).toHaveLength(2)
  })

  it('mantiene le code ordinarie e rappresenta una coda del link senza ampliarla', async () => {
    const { fetch } = renderSynergy(() => Promise.resolve(response(payload())), '/app/fit?section=matchups&relation=allies&queue=450')
    const select = screen.getByLabelText('Modalità')
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    expect(options.filter((option) => !option.disabled).map((option) => option.value).sort()).toEqual(['all', '400', '420', '430', '440', '480', '490', '700'].sort())
    expect(select).toHaveValue('450')
    expect(within(select).getByRole('option', { name: 'Modalità del link' })).toBeDisabled()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams.get('queue')).toBe('450')
  })

  it.each([
    { source: 'risposta', itemDelta: .07, settingDelta: .03, expectedPoints: '7' },
    { source: 'impostazioni per risposte precedenti', itemDelta: undefined, settingDelta: .07, expectedPoints: '7' },
    { source: 'valore predefinito', itemDelta: undefined, settingDelta: undefined, expectedPoints: '3' },
  ])('descrive la soglia della probabilità da $source in punti percentuali', async ({ itemDelta, settingDelta, expectedPoints }) => {
    const item = {
      champion: 'Lux', icon_url: '', games: 40, wins: 24, losses: 16, win_rate: 60,
      posterior_win_rate: 58, baseline_win_rate: 50, posterior_lift_pp: 8, relative_delta_pp: 8,
      credible_lower_90: 44, credible_upper_90: 72, direction_confidence: 80, direction_probability: 80,
      probability_meaningful_advantage: 70, probability_meaningful_disadvantage: 4,
      effective_sample_size: 40, personal_effective_sample_size: 40, reliability: 'indicative' as const,
      actionable: false, prior_source: 'neutral_50', prior_games: 0, meaningful_delta: itemDelta,
    }
    renderSynergy(() => Promise.resolve(response(payload({ games: 40, better_with: [item], worse_with: [{ ...item, champion: 'Zed' }] }))), undefined, settingDelta)

    const bars = await screen.findAllByRole('progressbar', { name: `Probabilità di un effetto oltre ${expectedPoints} punti percentuali` })
    expect(bars).toHaveLength(2)
    expect(bars[0]).toHaveAttribute('aria-valuenow', '70')
    expect(bars[1]).toHaveAttribute('aria-valuenow', '4')
  })
})
