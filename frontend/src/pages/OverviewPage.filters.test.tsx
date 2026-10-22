import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERVIEW_FILTERS_KEY } from '../app/overview-filters'
import { PLAN_BUDGET_KEY } from '../app/remembered-plan-budget'
import { OverviewPage } from './OverviewPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW'], companion: null, algorithmRevision: 4 }, scopeReady: true,
}) }))

const disposables: (() => void)[] = []
function response(url: URL) {
  const role = url.searchParams.get('role') ?? 'MIDDLE'
  const queue = url.searchParams.get('queue') ?? '420'
  const days = url.searchParams.get('days') ?? '180'
  const budget = Number(url.searchParams.get('budget') ?? 400)
  if (!['90', '180', '365', 'all'].includes(days)) return Response.json({ error: 'Periodo non valido' }, { status: 400 })
  const context = { role, queue, days, unique_games: role === 'SUPPORT' ? 0 : 12 }
  const champion = role === 'TOP' ? 'Garen' : 'Ahri'
  return Response.json({
    context, model: { validated: false, message: 'Risultato esplorativo.' },
    budget_total: budget, budget_assigned: role === 'SUPPORT' ? 0 : budget, budget_unassigned: role === 'SUPPORT' ? budget : 0,
    items: role === 'SUPPORT' ? [] : [{
      champion, role: role === 'ALL' ? 'MIDDLE' : role, icon_url: '', unique_games: 12,
      posterior_win_rate: 56, credible_lower_90: 30, credible_upper_90: 80, credible_mass: .9,
      historical_supported: false, classification: 'promising', allocation_games: budget,
    }],
  })
}

function setup(url = '/app/overview', handler = (url: URL): Promise<Response> => Promise.resolve(response(url))) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = new URL(String(input), 'http://localhost')
    expect(init?.method ?? 'GET').toBe('GET')
    if (requested.pathname === '/api/sync-status') return Response.json({ last_completed_at: null, sync_active: false })
    expect(['/api/champions', '/api/training-plan']).toContain(requested.pathname)
    requests.push(requested)
    return handler(requested)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createMemoryRouter([{ path: '*', element: <OverviewPage /> }], { initialEntries: [url] })
  const mounted = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  disposables.push(() => { mounted.unmount(); router.dispose(); client.clear() })
  return { requests, router, unmount: mounted.unmount, user: userEvent.setup() }
}

function expectPair(requests: URL[], expected: { role: string | null; queue: string | null; days: string | null }) {
  expect(requests.map((url) => url.pathname).sort()).toEqual(['/api/champions', '/api/training-plan'])
  for (const url of requests) {
    for (const [key, value] of Object.entries(expected)) expect(url.searchParams.get(key)).toBe(value)
    expect(url.searchParams.get('account')).toBe('Alpha#EUW')
    expect(url.searchParams.get('algorithm_revision')).toBe('4')
    if (url.pathname === '/api/training-plan') expect(url.searchParams.get('budget')).toBe('400')
  }
}

beforeEach(() => { localStorage.removeItem(OVERVIEW_FILTERS_KEY); localStorage.removeItem(PLAN_BUDGET_KEY) })
afterEach(() => { disposables.splice(0).forEach((dispose) => dispose()); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Filtri condivisi del Riepilogo', () => {
  it('conferma il budget con Invio, ricalcola solo il piano e conserva filtri e navigazione', async () => {
    const { requests, router, user } = setup('/app/overview?role=TOP&queue=440&days=90&keep=1')
    await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })
    const input = screen.getByRole('spinbutton', { name: 'Partite del piano' })
    await user.clear(input)
    await user.type(input, '120')
    expect(requests).toHaveLength(2)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]!.pathname).toBe('/api/training-plan')
    for (const [key, value] of Object.entries({ budget: '120', role: 'TOP', queue: '440', days: '90' })) {
      expect(requests[2]!.searchParams.get(key)).toBe(value)
      expect(new URLSearchParams(router.state.location.search).get(key)).toBe(value)
    }
    expect(new URLSearchParams(router.state.location.search).get('keep')).toBe('1')
    expect(await within(await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })).findByText('120')).toBeVisible()
    expect(new URL(screen.getByRole('link', { name: 'Apri il piano' }).getAttribute('href')!, 'http://localhost').searchParams.get('budget')).toBe('120')
    await user.selectOptions(screen.getByLabelText('Periodo'), 'all')
    await waitFor(() => expect(requests).toHaveLength(5))
    expect(requests.findLast((url) => url.pathname === '/api/training-plan')!.searchParams.get('budget')).toBe('120')
    await act(async () => { await router.navigate('/app/overview?budget=250') })
    expect(input).toHaveValue(250)
    await act(async () => { await router.navigate(-1) })
    expect(input).toHaveValue(120)
  })

  it.each([
    { draft: '', expected: 600 }, { draft: '-5', expected: 20 },
    { draft: '2500', expected: 2000 }, { draft: '123.9', expected: 123 },
    { draft: '1e3', expected: 1000 },
  ])('conferma la bozza $draft all’uscita dal campo con budget $expected', async ({ draft, expected }) => {
    const { requests, user } = setup('/app/overview?budget=600')
    await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })
    const input = screen.getByRole('spinbutton', { name: 'Partite del piano' })
    await user.click(input)
    fireEvent.change(input, { target: { value: draft } })
    expect(requests).toHaveLength(2)
    await user.tab()
    expect(input).toHaveValue(expected)
    await waitFor(() => expect(requests).toHaveLength(expected === 600 ? 2 : 3))
    expect(requests.at(-1)!.searchParams.get('budget')).toBe(String(expected))
  })

  it('mantiene modificabile il budget durante il ricalcolo e ignora il piano tardivo', async () => {
    let finish: (() => void) | undefined
    const { user, requests } = setup('/app/overview', (url) => url.searchParams.get('budget') === '100'
      ? new Promise((resolve) => { finish = () => resolve(response(url)) }) : Promise.resolve(response(url)))
    await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })
    const input = screen.getByRole('spinbutton', { name: 'Partite del piano' })
    await user.clear(input)
    await user.type(input, '100{Enter}')
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(screen.getByRole('list', { name: 'Campioni da confrontare' })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Anteprima delle partite assegnate' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Calcolo dell’anteprima del piano')).toBeVisible()
    expect(input).toBeEnabled()
    expect(new URL(screen.getByRole('link', { name: 'Apri il piano' }).getAttribute('href')!, 'http://localhost').searchParams.get('budget')).toBe('100')
    await user.clear(input)
    await user.type(input, '200{Enter}')
    expect(await within(await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })).findByText('200')).toBeVisible()
    await act(async () => finish?.())
    expect(input).toHaveValue(200)
    expect(within(screen.getByRole('list', { name: 'Anteprima delle partite assegnate' })).queryByText('100')).not.toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '500{Escape}')
    expect(input).toHaveValue(200)
    expect(requests).toHaveLength(4)
  })

  it('mantiene il budget confermato e riprova lo stesso piano dopo un errore', async () => {
    let fail = true
    const { user, requests } = setup('/app/overview', (url) => Promise.resolve(url.searchParams.get('budget') === '150' && fail
      ? Response.json({ error: 'Indisponibile' }, { status: 503 }) : response(url)))
    await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })
    const input = screen.getByRole('spinbutton', { name: 'Partite del piano' })
    await user.clear(input)
    await user.type(input, '150{Enter}')
    await screen.findByRole('heading', { name: 'Piano non disponibile' })
    expect(input).toHaveValue(150)
    expect(screen.getByRole('list', { name: 'Campioni da confrontare' })).toBeVisible()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await within(await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })).findByText('150')).toBeVisible()
    expect(requests.slice(-2).map((url) => url.searchParams.get('budget'))).toEqual(['150', '150'])
  })

  it('applica la selezione salvata alla prima richiesta di entrambe le analisi', async () => {
    localStorage.setItem(OVERVIEW_FILTERS_KEY, JSON.stringify({ role: 'TOP', queue: 'all', days: '365' }))
    const { requests } = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    expect(screen.getByLabelText('Ruolo')).toHaveValue('TOP')
    expect(screen.getByLabelText('Modalità')).toHaveValue('all')
    expect(screen.getByLabelText('Periodo')).toHaveValue('365')
    expectPair(requests, { role: 'TOP', queue: 'all', days: '365' })
  })

  it('cambia insieme ruolo, modalità e periodo delle due analisi e li ricorda alla riapertura', async () => {
    const { requests, user, unmount, router } = setup('/app/overview?keep=1')
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    expectPair(requests, { role: null, queue: null, days: null })
    for (const [label, value, expected] of [
      ['Ruolo', 'TOP', { role: 'TOP', queue: null, days: null }],
      ['Modalità', '440', { role: 'TOP', queue: '440', days: null }],
      ['Periodo', '90', { role: 'TOP', queue: '440', days: '90' }],
    ] as const) {
      const start = requests.length
      await user.selectOptions(screen.getByLabelText(label), value)
      await waitFor(() => expect(requests.length).toBe(start + 2))
      expectPair(requests.slice(start), expected)
    }
    expect(new URLSearchParams(router.state.location.search).get('keep')).toBe('1')
    expect(JSON.parse(localStorage.getItem(OVERVIEW_FILTERS_KEY)!)).toEqual({ role: 'TOP', queue: '440', days: '90' })
    unmount()
    const reopened = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    expectPair(reopened.requests, { role: 'TOP', queue: '440', days: '90' })
    expect(screen.getByLabelText('Periodo')).toHaveValue('90')
  })

  it('rispetta i filtri dei link e la navigazione senza ereditare quelli mancanti dal browser', async () => {
    localStorage.setItem(OVERVIEW_FILTERS_KEY, JSON.stringify({ role: 'TOP', queue: '440', days: '90' }))
    const { requests, router } = setup('/app/overview?role=ALL')
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    expectPair(requests, { role: 'ALL', queue: null, days: null })
    expect(screen.getByLabelText('Modalità')).toHaveValue('')
    await act(async () => { await router.navigate('/app/overview?role=TOP&queue=all&days=365') })
    await waitFor(() => expect(requests).toHaveLength(4))
    expectPair(requests.slice(-2), { role: 'TOP', queue: 'all', days: '365' })
    await act(async () => { await router.navigate(-1) })
    expect(screen.getByLabelText('Ruolo')).toHaveValue('ALL')
    expect(screen.getByLabelText('Periodo')).toHaveValue('')
  })

  it('nasconde entrambi i vecchi risultati durante il cambio e ignora le risposte tardive', async () => {
    const pending: (() => void)[] = []
    const { user } = setup('/app/overview', (url) => url.searchParams.get('role') === 'ALL'
      ? new Promise((resolve) => pending.push(() => resolve(response(url)))) : Promise.resolve(response(url)))
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })
    await user.selectOptions(screen.getByLabelText('Ruolo'), 'ALL')
    expect(screen.queryByText('Ahri')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Caricamento del riepilogo dei campioni')).toBeVisible()
    expect(screen.getByLabelText('Calcolo dell’anteprima del piano')).toBeVisible()
    for (const name of ['Confronta i campioni', 'Apri il piano']) {
      expect(new URL(screen.getByRole('link', { name }).getAttribute('href')!, 'http://localhost').searchParams.get('role')).toBe('ALL')
    }
    await user.selectOptions(screen.getByLabelText('Ruolo'), 'TOP')
    await screen.findByRole('link', { name: 'Apri la scheda di Garen, Corsia superiore' })
    await act(async () => pending.forEach((resolve) => resolve()))
    expect(screen.queryByText('Ahri')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Ruolo')).toHaveValue('TOP')
    expect(within(screen.getByRole('list', { name: 'Anteprima delle partite assegnate' })).getByText('Garen')).toBeVisible()
  })

  it('conserva una selezione senza risultati e ripristina esplicitamente i default salvati', async () => {
    const { requests, user, unmount } = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    await user.selectOptions(screen.getByLabelText('Ruolo'), 'SUPPORT')
    await screen.findByRole('heading', { name: 'Nessun campione nel contesto attuale' })
    expect(screen.getByLabelText('Ruolo')).toHaveValue('SUPPORT')
    expect(JSON.parse(localStorage.getItem(OVERVIEW_FILTERS_KEY)!).role).toBe('SUPPORT')
    await user.click(screen.getByRole('button', { name: 'Ripristina filtri predefiniti' }))
    expect(screen.getByLabelText('Ruolo')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Ripristina filtri predefiniti' })).toBeDisabled()
    expect(JSON.parse(localStorage.getItem(OVERVIEW_FILTERS_KEY)!)).toEqual({ role: '', queue: '', days: '' })
    // The cached default results can return immediately without another fetch.
    expect(requests).toHaveLength(4)
    unmount()
    const reopened = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    expectPair(reopened.requests, { role: null, queue: null, days: null })
  })

  it.each(['{broken', JSON.stringify({ role: {}, queue: '450', days: '999' })])('recupera preferenze salvate non valide: %s', async (raw) => {
    localStorage.setItem(OVERVIEW_FILTERS_KEY, raw)
    const { requests } = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    expectPair(requests, { role: null, queue: null, days: null })
  })

  it('mantiene operativi i filtri se il browser blocca lettura e salvataggio', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    const { user, requests } = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    await user.selectOptions(screen.getByLabelText('Periodo'), 'all')
    await waitFor(() => expect(requests).toHaveLength(4))
    expectPair(requests.slice(-2), { role: null, queue: null, days: 'all' })
    expect(screen.getByText(/Il browser non consente di ricordarli/)).toBeVisible()
  })

  it('non sostituisce un periodo non valido del link con dati del periodo predefinito', async () => {
    const { requests } = setup('/app/overview?days=invalid')
    await screen.findByRole('heading', { name: 'Riepilogo dei campioni non disponibile' })
    await screen.findByRole('heading', { name: 'Piano non disponibile' })
    expectPair(requests, { role: null, queue: null, days: 'invalid' })
    expect(screen.getByLabelText('Periodo')).toHaveValue('invalid')
    expect(screen.queryByRole('list', { name: 'Campioni da confrontare' })).not.toBeInTheDocument()
  })
})
