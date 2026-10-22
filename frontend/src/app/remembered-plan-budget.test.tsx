import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCompetitivePlanFilters } from './competitive-plan-filters'
import { useOverviewBudget } from './overview-budget'
import { OVERVIEW_FILTERS_KEY, useOverviewFilters } from './overview-filters'
import { COMPETITIVE_PLAN_FILTERS_KEY, PLAN_BUDGET_KEY } from './remembered-plan-budget'

function Overview() {
  const control = useOverviewBudget()
  const context = useOverviewFilters(control.budget)
  return <>
    <label>Budget riepilogo<input type="number" value={control.value} onChange={(event) => control.setValue(event.target.value)}
      onBlur={control.commit} onKeyDown={(event) => { if (event.key === 'Enter') control.commit() }} /></label>
    <output data-testid="budget">{control.budget}</output><output data-testid="storage">{String(control.storageAvailable)}</output>
    <output data-testid="context">{JSON.stringify(context.filters)}</output><output data-testid="url">{useLocation().search}</output>
    <button onClick={() => context.updateFilters({ role: 'TOP' })}>Cambia ruolo</button>
  </>
}

function Plan() {
  const { filters, updateFilters, storageAvailable } = useCompetitivePlanFilters()
  return <>
    <output data-testid="budget">{filters.budget}</output><output data-testid="storage">{String(storageAvailable)}</output>
    <output data-testid="context">{JSON.stringify(filters)}</output><output data-testid="url">{useLocation().search}</output>
    <button onClick={() => updateFilters({ budget: '180' })}>Scegli180</button>
    <button onClick={() => updateFilters({ days: '365' })}>Cambia periodo</button>
  </>
}

const routers: ReturnType<typeof createMemoryRouter>[] = []
function mount(url = '/app/overview') {
  const router = createMemoryRouter([
    { path: '/app/overview', element: <Overview /> },
    { path: '/app/plan', element: <Plan /> },
  ], { initialEntries: [url] })
  routers.push(router)
  const view = render(<RouterProvider router={router} />)
  return { ...view, navigate: async (url: string) => { await act(async () => { await router.navigate(url) }) } }
}

afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('budget condiviso tra riepilogo e piano competitivo', () => {
  it('riusa le scelte in entrambe le direzioni e dopo una nuova apertura senza cambiare il piano seguito', async () => {
    const trackedId = '12345678-1234-1234-1234-123456789abc'
    localStorage.setItem('champion-fit:followed-plan:v1', trackedId)
    const view = mount()
    const input = screen.getByLabelText('Budget riepilogo')
    fireEvent.change(input, { target: { value: '120' } })
    expect(screen.getByTestId('budget')).toHaveTextContent('400')
    expect(localStorage.getItem(PLAN_BUDGET_KEY)).toBeNull()
    fireEvent.blur(input)
    expect(screen.getByTestId('budget')).toHaveTextContent('120')
    await view.navigate('/app/plan?section=tournament')
    expect(screen.getByTestId('budget')).toHaveTextContent('120')
    await userEvent.click(screen.getByRole('button', { name: 'Scegli180' }))
    await view.navigate('/app/overview')
    expect(screen.getByLabelText('Budget riepilogo')).toHaveValue(180)
    view.unmount()
    mount()
    expect(screen.getByLabelText('Budget riepilogo')).toHaveValue(180)
    expect(localStorage.getItem('champion-fit:followed-plan:v1')).toBe(trackedId)
  })

  it.each(['/app/overview', '/app/plan'])('riusa il vecchio budget del piano in %s senza riscriverlo all’apertura', (url) => {
    const legacy = JSON.stringify({ budget: '260', role: 'JUNGLE', queue: '440', days: '90' })
    localStorage.setItem(COMPETITIVE_PLAN_FILTERS_KEY, legacy)
    mount(url)
    expect(screen.getByTestId('budget')).toHaveTextContent('260')
    expect(localStorage.getItem(PLAN_BUDGET_KEY)).toBeNull()
    expect(localStorage.getItem(COMPETITIVE_PLAN_FILTERS_KEY)).toBe(legacy)
  })

  it.each(['/app/overview', '/app/plan'])('rispetta budget, alias e default dei link espliciti in %s senza salvare il link', async (path) => {
    localStorage.setItem(PLAN_BUDGET_KEY, '120')
    const view = mount(`${path}?budget=600&n=900`)
    expect(screen.getByTestId('budget')).toHaveTextContent('600')
    await view.navigate(`${path}?n=650`)
    expect(screen.getByTestId('budget')).toHaveTextContent('650')
    for (const query of ['role=TOP', 'queue=440', 'days=90', 'budget=', 'budget=invalid']) {
      await view.navigate(`${path}?${query}`)
      expect(screen.getByTestId('budget')).toHaveTextContent('400')
    }
    expect(localStorage.getItem(PLAN_BUDGET_KEY)).toBe('120')
    await view.navigate(path)
    expect(screen.getByTestId('budget')).toHaveTextContent('120')
  })

  it('mantiene il budget ricordato durante una modifica ai filtri di entrambe le superfici', async () => {
    localStorage.setItem(PLAN_BUDGET_KEY, '120')
    localStorage.setItem(OVERVIEW_FILTERS_KEY, JSON.stringify({ role: 'MIDDLE', queue: '440', days: '90' }))
    localStorage.setItem(COMPETITIVE_PLAN_FILTERS_KEY, JSON.stringify({ budget: '260', role: 'JUNGLE', queue: '420', days: '180' }))
    const view = mount('/app/overview?keep=1&account=Alpha&account=Beta')
    await userEvent.click(screen.getByRole('button', { name: 'Cambia ruolo' }))
    expect(screen.getByTestId('budget')).toHaveTextContent('120')
    let params = new URLSearchParams(screen.getByTestId('url').textContent ?? '')
    expect(params.get('budget')).toBe('120')
    expect(params.get('role')).toBe('TOP')
    expect(params.get('queue')).toBe('440')
    expect(params.getAll('account')).toEqual(['Alpha', 'Beta'])
    expect(params.get('keep')).toBe('1')
    await view.navigate('/app/plan?keep=2')
    await userEvent.click(screen.getByRole('button', { name: 'Cambia periodo' }))
    expect(screen.getByTestId('budget')).toHaveTextContent('120')
    params = new URLSearchParams(screen.getByTestId('url').textContent ?? '')
    expect(params.get('budget')).toBe('120')
    expect(params.get('role')).toBe('JUNGLE')
    expect(params.get('days')).toBe('365')
    expect(params.get('keep')).toBe('2')
    expect(localStorage.getItem(PLAN_BUDGET_KEY)).toBe('120')
  })

  it.each(['NaN', '19', '2001', '1e3', '{}', ''])('ignora la preferenza corrotta %j', (value) => {
    localStorage.setItem(PLAN_BUDGET_KEY, value)
    mount()
    expect(screen.getByTestId('budget')).toHaveTextContent('400')
  })

  it('mantiene i controlli e il link funzionanti quando lo storage è bloccato', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    const view = mount()
    fireEvent.change(screen.getByLabelText('Budget riepilogo'), { target: { value: '120' } })
    fireEvent.blur(screen.getByLabelText('Budget riepilogo'))
    expect(screen.getByTestId('budget')).toHaveTextContent('120')
    expect(screen.getByTestId('storage')).toHaveTextContent('false')
    expect(screen.getByTestId('url')).toHaveTextContent('budget=120')
    await view.navigate('/app/plan?budget=120')
    await userEvent.click(screen.getByRole('button', { name: 'Scegli180' }))
    expect(screen.getByTestId('budget')).toHaveTextContent('180')
    expect(screen.getByTestId('storage')).toHaveTextContent('false')
  })
})
