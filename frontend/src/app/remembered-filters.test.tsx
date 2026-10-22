import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPETITIVE_PLAN_FILTERS_KEY, useCompetitivePlanFilters } from './competitive-plan-filters'
import { MATCH_HISTORY_DEFAULTS, MATCH_HISTORY_FILTERS_KEY, useMatchHistoryFilters } from './match-history-filters'

function HistoryControls() {
  const { filters, updateFilters, storageAvailable } = useMatchHistoryFilters()
  return <>
    <output data-testid="filters">{JSON.stringify(filters)}</output><output data-testid="storage">{String(storageAvailable)}</output>
    <output data-testid="url">{useLocation().search}</output>
    <button onClick={() => updateFilters({ champion: 'Ahri', role: 'MIDDLE', queue: '420', days: '90' })}>Personalizza</button>
    <button onClick={() => updateFilters({ days: '365' })}>Cambia periodo</button>
    <button onClick={() => updateFilters(MATCH_HISTORY_DEFAULTS)}>Azzera</button>
  </>
}

function PlanControls() {
  const { filters, updateFilters } = useCompetitivePlanFilters()
  return <>
    <output data-testid="filters">{JSON.stringify(filters)}</output><output data-testid="url">{useLocation().search}</output>
    <button onClick={() => updateFilters({ budget: '80', role: 'JUNGLE', queue: '420', days: '180' })}>Personalizza</button>
    <button onClick={() => updateFilters({ budget: '400' })}>Budget predefinito</button>
  </>
}

const routers: ReturnType<typeof createMemoryRouter>[] = []
function mount(url = '/app/matches') {
  const router = createMemoryRouter([
    { path: '/app/matches', element: <HistoryControls /> },
    { path: '/app/fit', element: <PlanControls /> },
  ], { initialEntries: [url] })
  routers.push(router)
  return render(<RouterProvider router={router} />)
}
const selected = () => JSON.parse(screen.getByTestId('filters').textContent ?? '{}') as Record<string, string>

afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('selezioni ricordate senza sincronizzazioni esterne', () => {
  it('ritrova le selezioni tornando da un link senza filtri e le materializza alla prima modifica', async () => {
    let view = mount()
    await userEvent.click(screen.getByRole('button', { name: 'Personalizza' }))
    view.unmount()
    view = mount('/app/matches?section=history&flag=loss&account=Alpha&account=Beta')
    expect(selected()).toEqual({ champion: 'Ahri', role: 'MIDDLE', queue: '420', days: '90' })
    await userEvent.click(screen.getByRole('button', { name: 'Cambia periodo' }))
    const params = new URLSearchParams(screen.getByTestId('url').textContent ?? '')
    expect(params.get('champion')).toBe('Ahri')
    expect(params.get('role')).toBe('MIDDLE')
    expect(params.get('days')).toBe('365')
    expect(params.get('flag')).toBe('loss')
    expect(params.getAll('account')).toEqual(['Alpha', 'Beta'])
    view.unmount()
    mount()
    expect(selected().days).toBe('365')
  })

  it('un link esplicito usa i propri default e non sovrascrive le preferenze solo perché viene aperto', () => {
    const saved = { champion: 'Ahri', role: 'MIDDLE', queue: '420', days: '90' }
    localStorage.setItem(MATCH_HISTORY_FILTERS_KEY, JSON.stringify(saved))
    const view = mount('/app/matches?queue=440')
    expect(selected()).toEqual({ ...MATCH_HISTORY_DEFAULTS, queue: '440' })
    expect(JSON.parse(localStorage.getItem(MATCH_HISTORY_FILTERS_KEY)!)).toEqual(saved)
    view.unmount()
    mount()
    expect(selected()).toEqual(saved)
  })

  it('azzera anche le preferenze salvate senza perdere il resto del link', async () => {
    const view = mount('/app/matches?champion=Ahri&role=MIDDLE&flag=afk')
    await userEvent.click(screen.getByRole('button', { name: 'Azzera' }))
    expect(selected()).toEqual(MATCH_HISTORY_DEFAULTS)
    expect(screen.getByTestId('url')).toHaveTextContent('?flag=afk')
    view.unmount()
    mount()
    expect(selected()).toEqual(MATCH_HISTORY_DEFAULTS)
  })

  it('ricorda anche budget e contesto del piano, mantenendoli distinti dallo storico', async () => {
    let view = mount('/app/fit?section=tournament')
    await userEvent.click(screen.getByRole('button', { name: 'Personalizza' }))
    view.unmount()
    view = mount('/app/fit?section=tournament')
    expect(selected()).toEqual({ budget: '80', role: 'JUNGLE', queue: '420', days: '180' })
    view.unmount()
    mount('/app/matches')
    expect(selected()).toEqual(MATCH_HISTORY_DEFAULTS)
  })

  it('il budget predefinito esplicito prevale sul vecchio parametro n', async () => {
    mount('/app/fit?section=tournament&n=650&role=utility&queue=RANKEDSOLO')
    await userEvent.click(screen.getByRole('button', { name: 'Budget predefinito' }))
    expect(selected().budget).toBe('400')
    const params = new URLSearchParams(screen.getByTestId('url').textContent ?? '')
    expect(params.get('budget')).toBe('400')
    expect(params.get('n')).toBe('650')
    expect(params.get('role')).toBe('utility')
    expect(params.get('queue')).toBe('RANKEDSOLO')
  })

  it('ignora valori salvati non validi e conserva invece i link espliciti per la validazione del server', () => {
    localStorage.setItem(COMPETITIVE_PLAN_FILTERS_KEY, JSON.stringify({ budget: 'NaN', role: 'NO', queue: 'bad', days: '-10' }))
    const view = mount('/app/fit')
    expect(selected()).toEqual({ budget: '400', role: '', queue: '', days: '' })
    view.unmount()
    mount('/app/matches?role=INVALID&days=wrong')
    expect(selected().role).toBe('INVALID')
    expect(selected().days).toBe('wrong')
  })

  it('con storage bloccato continua a filtrare tramite URL e segnala la mancata persistenza', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Personalizza' }))
    expect(selected().champion).toBe('Ahri')
    expect(screen.getByTestId('storage')).toHaveTextContent('false')
    expect(screen.getByTestId('url')).toHaveTextContent('champion=Ahri')
  })
})
