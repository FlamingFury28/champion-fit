import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopeSnapshot } from '../api/client'
import type { AlgorithmSettings, RecommendationDto, RecommendationEvidenceResponseDto } from '../api/types'
import { queryKeys } from '../api/queries'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS, setSetting } from '../app/algorithm-settings'
import { RecommendationCard } from './RecommendationCard'

const scope: ScopeSnapshot = { accounts: ['Alpha#EUW'], companion: null }
const recommendation: RecommendationDto = {
  champion: 'Ahri', role: 'MIDDLE', score: 41, games: 4, posterior_fit: 62,
  credible_lower_90: 41, credible_upper_90: 83, effective_evidence: 2.5,
  reason: 'Un segnale da verificare.', confidence: 'limitata', actionable: true,
  reliability: 'reliable', baseline_win_rate: 50, probability_meaningful_advantage: 96,
  decision_threshold: 95, raw_win_rate: 60,
  explanation: {
    positive_evidence: 2, negative_evidence: 0.5, prior_fit: 50, prior_evidence: 6,
    prior_share: 70.6, uncertainty_width_90: 42, uncertainty_level: 'high',
    uncertainty_reasons: ['Poche partite informative.'], summary: 'Il limite prudente favorisce Ahri tra i champion osservati.',
    next_step: 'Raccogli altre partite prima di consolidare la scelta.',
  },
}

function evidenceResponse(overrides: Partial<RecommendationEvidenceResponseDto> = {}): RecommendationEvidenceResponseDto {
  return {
    champion: 'Ahri', role: 'MIDDLE', total: 1, limit: 20, offset: 0,
    summary: { games: 1, wins: 0, losses: 1, positive_evidence: 0, negative_evidence: 0, discounted_games: 0, excluded_games: 1 },
    items: [{ match_id: 'EUW1-ALPHA', account: 'Alpha#EUW', date: '2026-09-01', champion: 'Ahri', role: 'MIDDLE', win: 0, queue: 'RANKED_SOLO_5x5', duration_minutes: 28, evidence_weight: 0, contribution: 'excluded', weight_reason: 'Sconfitta esclusa: AFK annotato.' }],
    ...overrides,
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function setup(item = recommendation, explanationOnly = false, settings?: AlgorithmSettings) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  if (settings) client.setQueryData(queryKeys.algorithmSettings, { revision: 1, settings })
  const view = (currentScope = scope) => {
    const content = <MemoryRouter initialEntries={['/app/fit?section=choices&role=TOP&search=Ahri']}><RecommendationCard scope={currentScope} item={item} rank={1} explanationOnly={explanationOnly} /></MemoryRouter>
    return <QueryClientProvider client={client}>{settings ? <AlgorithmSettingsProvider>{content}</AlgorithmSettingsProvider> : content}</QueryClientProvider>
  }
  const result = render(view())
  return { ...result, user: userEvent.setup(), changeScope: (currentScope: ScopeSnapshot) => result.rerender(view(currentScope)) }
}

afterEach(() => vi.unstubAllGlobals())

describe('RecommendationCard', () => {
  it.each([{ delta: .09, points: '9' }, { delta: undefined, points: '7' }])('descrive la soglia $points e il minimo decisionale configurati', async ({ delta, points }) => {
    const settings = setSetting(setSetting(RECOMMENDED_ALGORITHM_SETTINGS, 'evidence.min_games', 40), 'evidence.meaningful_delta', .07)
    const { user } = setup({ ...recommendation, meaningful_delta: delta }, false, settings)
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    expect(screen.getByText(new RegExp(`Probabilità di superare il riferimento di almeno ${points} punti percentuali`))).toBeVisible()
    expect(screen.getByText(/Servono anche almeno 40 partite personali distinte/)).toBeVisible()
  })

  it('mantiene spiegazione e audit senza duplicare la navigazione nella scheda incorporata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(evidenceResponse())))
    const { user } = setup(recommendation, true)

    expect(screen.queryByRole('link', { name: 'Apri la scheda completa' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))
    expect(await screen.findByText('EUW1-ALPHA')).toBeVisible()
  })

  it('spiega stima, intervallo e prior senza caricare partite prima della richiesta', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { user } = setup()

    expect(screen.getByText('Incertezza alta')).toBeVisible()
    expect(screen.getByText('Scelta supportata')).toBeVisible()
    expect(screen.getByText('vittorie stimate').parentElement).toHaveTextContent('62%')
    expect(screen.getByText('vittorie stimate')).toBeVisible()
    expect(screen.getByText('limite prudente 90% · 41%')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Vedi i dati' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Apri la scheda completa' })).toHaveAttribute('href', '/app/fit?section=choices&role=TOP&search=Ahri&detail=Ahri&detailRole=MIDDLE')
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    expect(screen.getByText('Il limite prudente favorisce Ahri tra i campioni osservati.')).toBeVisible()
    expect(screen.getByText(/Intervallo credibile al 90%/)).toBeVisible()
    expect(screen.getByText(/4 partite distinte · 2,5 di peso attribuito nella revisione/)).toBeVisible()
    expect(screen.getByText(/del peso della stima è assegnato all’ipotesi iniziale/)).toBeVisible()
    expect(screen.getByText(/Percentuale di vittorie osservata 60% · riferimento 50%/)).toBeVisible()
    expect(screen.getByText(/Probabilità di superare il riferimento di almeno 3 punti percentuali: 96% · soglia richiesta 95%/)).toBeVisible()
    expect(screen.getByText(/Servono anche almeno 20 partite personali distinte/)).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    expect(screen.queryByRole('button', { name: 'Mostra le partite' })).not.toBeInTheDocument()
  })

  it('mostra partite tracciabili con peso zero e pagina successiva senza righe precedenti', async () => {
    let finishNextPage: ((value: Response) => void) | undefined
    const firstPage = evidenceResponse({ total: 21 })
    const fetch = vi.fn().mockResolvedValueOnce(json(firstPage)).mockImplementationOnce(() => new Promise<Response>((resolve) => { finishNextPage = resolve }))
    vi.stubGlobal('fetch', fetch)
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))

    expect(await screen.findByRole('table', { name: 'Partite a supporto di Ahri in Corsia centrale' })).toBeVisible()
    expect(screen.getByText('EUW1-ALPHA')).toBeVisible()
    expect(screen.getByText(/Alpha#EUW/)).toBeVisible()
    expect(screen.getByText('Peso 0')).toBeVisible()
    expect(screen.getByText('Esclusa dall’attribuzione')).toBeVisible()
    expect(screen.getByText('Sconfitta esclusa: AFK annotato.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Partite successive' }))
    expect(screen.queryByText('EUW1-ALPHA')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Caricamento partite di Ahri' })).toBeVisible()
    expect(String(fetch.mock.calls[1]?.[0])).toContain('offset=20')
    finishNextPage!(json(evidenceResponse({ total: 21, offset: 20, items: [{ ...firstPage.items[0]!, match_id: 'EUW1-LAST' }] })))
    expect(await screen.findByText('EUW1-LAST')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Partite successive' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Partite precedenti' })).toBeEnabled()
  })

  it.each([
    { date: '2026-W39-4T23:30:00Z', date_utc: '2026-09-24T23:30:00.000000+00:00' },
    { date: '2026-09-01', date_utc: null },
    { date: '2026-09-01', date_utc: undefined },
  ])('mostra una data canonica leggibile e conserva il fallback per date_utc=$date_utc', async (dateFields) => {
    const response = evidenceResponse()
    response.items = [{ ...response.items[0]!, ...dateFields }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(response)))
    const { container, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))
    await screen.findByText('EUW1-ALPHA')

    const date = dateFields.date_utc ?? dateFields.date
    const time = container.querySelector('time')
    expect(time).toHaveAttribute('datetime', date)
    expect(time).toHaveTextContent(new Date(date).toLocaleDateString('it-IT'))
    expect(time).not.toHaveTextContent('2026-W39-4')
  })

  it('chiude e cancella la pagina visibile cambiando account o companion', async () => {
    const betaScope: ScopeSnapshot = { accounts: ['Beta#EUW'], companion: null }
    const companionScope: ScopeSnapshot = { accounts: ['Beta#EUW'], companion: { name: 'Duo', accounts: ['Friend#EUW'], profileAccounts: ['Beta#EUW'], mode: 'only' } }
    const firstPage = evidenceResponse()
    const fetch = vi.fn().mockResolvedValueOnce(json(firstPage)).mockResolvedValueOnce(json(evidenceResponse({ items: [{ ...firstPage.items[0]!, account: 'Beta#EUW', match_id: 'EUW1-BETA' }] }))).mockResolvedValueOnce(json(evidenceResponse({ total: 0, items: [] })))
    vi.stubGlobal('fetch', fetch)
    const { user, changeScope } = setup()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))
    expect(await screen.findByText('EUW1-ALPHA')).toBeVisible()

    changeScope(betaScope)
    expect(screen.queryByText('EUW1-ALPHA')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))
    expect(await screen.findByText('EUW1-BETA')).toBeVisible()
    expect(String(fetch.mock.calls[1]?.[0])).toContain('account=Beta%23EUW')

    changeScope(companionScope)
    expect(screen.queryByText('EUW1-BETA')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))
    expect(await screen.findByText('Nessuna partita da mostrare')).toBeVisible()
    expect(String(fetch.mock.calls[2]?.[0])).toContain('companion_account=Friend%23EUW')
    expect(String(fetch.mock.calls[2]?.[0])).toContain('companion_mode=only')
  })

  it('offre un nuovo tentativo dopo un errore e gestisce il risultato vuoto', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: 'Archivio temporaneamente non disponibile.' }, 503)).mockResolvedValueOnce(json(evidenceResponse({ total: 0, items: [], summary: { games: 0, wins: 0, losses: 0, positive_evidence: 0, negative_evidence: 0, discounted_games: 0, excluded_games: 0 } })))
    vi.stubGlobal('fetch', fetch)
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Partite non disponibili')
    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByText('Nessuna partita da mostrare')).toBeVisible()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('non inventa una scomposizione quando il server non invia la spiegazione', async () => {
    const { user } = setup({ ...recommendation, explanation: undefined })
    expect(screen.getByText('Incertezza da valutare')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Perché Ahri in Corsia centrale?' }))
    expect(screen.getByText(/La scomposizione tra ipotesi iniziale/)).toBeVisible()
    expect(screen.getByText('Un segnale da verificare.')).toBeVisible()
  })
})
