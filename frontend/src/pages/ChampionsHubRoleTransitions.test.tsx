import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeRole } from '../app/filters'
import { recommendationRoleFilter } from '../app/recommendation-filters'
import { ChampionsHubPage } from './ChampionsHubPage'

// Keep ChampionsHubPage, SectionNavigation and all link helpers real. Independent
// child pages expose the actual role policy of the destination without API setup.
function ConsumerProbe({ name, recommendation = false }: { name: string; recommendation?: boolean }) {
  const [params] = useSearchParams()
  const role = recommendation ? recommendationRoleFilter(params.get('role')) ?? 'ALL' : normalizeRole(params.get('role'))
  return <section aria-label={name}><h2>{name}</h2><output aria-label="Ruolo effettivo">{role}</output></section>
}

vi.mock('./ChampionDetailPage', () => ({ ChampionDetailPage: () => null }))
vi.mock('./FitPage', () => ({ FitPage: () => <ConsumerProbe name="Scelte osservate" recommendation /> }))
vi.mock('./ScoutPage', () => ({ ScoutPage: () => <ConsumerProbe name="Scoperte di catalogo" recommendation /> }))
vi.mock('./TestPlanPage', () => ({ TestPlanPage: () => <ConsumerProbe name="Prove di catalogo" recommendation /> }))
vi.mock('./ChampionPerformancePage', () => ({ ChampionPerformancePage: () => <ConsumerProbe name="Rendimento comune" /> }))
vi.mock('./CompetitivePlanPage', () => ({ CompetitivePlanPage: () => <ConsumerProbe name="Piano comune" /> }))
vi.mock('./ChampionsPage', () => ({ ChampionsPage: () => <ConsumerProbe name="Avversari comuni" /> }))
vi.mock('./SynergyPage', () => ({ SynergyPage: () => <ConsumerProbe name="Alleati comuni" /> }))

const disposables: (() => void)[] = []
const detailKeys = ['detail', 'detailRole', 'detailQueue', 'detailDays']

function setup(section: string, training: string, rawRole: string, relation = 'enemies') {
  const params = new URLSearchParams({
    section, training, role: rawRole, relation, queue: 'RANKED_FLEX_SR', days: '0',
    search: ' ', tag: 'ALL', minSimilarity: '0', budget: '1000',
    account: 'Alpha#EUW', companion_account: 'Gamma#EUW', companion_mode: 'exclude', algorithm_revision: '4',
    detailRole: 'TOP', detailQueue: '420', detailDays: '365',
  })
  params.append('account', 'Beta#EUW')
  const initialSearch = `?${params}`
  const router = createMemoryRouter([{ path: '/app/fit', element: <ChampionsHubPage /> }], {
    initialEntries: [{ pathname: '/app/fit', search: initialSearch, state: { source: 'section-transition-test' } }],
  })
  disposables.push(() => router.dispose())
  render(<RouterProvider router={router} />)
  return { router, params, initialSearch, user: userEvent.setup() }
}
type State = ReturnType<typeof setup>

function expectLinkContext(state: State, link: HTMLElement, expectedSection: string, expectedRole: string, secondary = false) {
  const destination = new URL(link.getAttribute('href')!, 'http://localhost')
  expect(destination.pathname).toBe('/app/fit')
  expect(destination.searchParams.get('section')).toBe(expectedSection)
  expect.soft(destination.searchParams.get('role')).toBe(expectedRole)
  expect.soft(destination.searchParams.get('days')).toBe('all')
  for (const key of detailKeys) expect(destination.searchParams.has(key)).toBe(false)
  for (const [key, value] of state.params) {
    if (!['section', 'role', 'days', 'training', 'account', ...detailKeys].includes(key)) expect(destination.searchParams.get(key)).toBe(value)
  }
  expect(destination.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(destination.searchParams.get('training')).toBe(secondary ? null : state.params.get('training'))
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
})

describe('link del contenitore campioni fra suggerimenti e analisi comuni', () => {
  it.each([
    { source: 'choices', training: 'discover', raw: 'MID', role: 'MIDDLE', link: 'Quali giochi meglio?', target: 'best', destination: 'Rendimento comune', relation: 'enemies', secondary: false },
    { source: 'training', training: 'discover', raw: '\u0085 adc \u001f', role: 'BOTTOM', link: 'Piano competitivo', target: 'tournament', destination: 'Piano comune', relation: 'enemies', secondary: false },
    { source: 'training', training: 'plan', raw: ' mid ', role: 'MIDDLE', link: 'Avversari e alleati', target: 'matchups', destination: 'Avversari comuni', relation: 'enemies', secondary: true },
    { source: 'choices', training: 'plan', raw: 'ADC', role: 'BOTTOM', link: 'Avversari e alleati', target: 'matchups', destination: 'Alleati comuni', relation: 'allies', secondary: true },
  ])('mantiene $role da $source/$training a $destination', async ({ source, training, raw, role, link, target, destination, relation, secondary }) => {
    const state = setup(source, training, raw, relation)
    expect(screen.getByRole('status', { name: 'Ruolo effettivo' })).toHaveTextContent(role)
    expect(state.router.state.location.search).toBe(state.initialSearch)
    expect(new URLSearchParams(state.router.state.location.search).get('role')).toBe(raw)

    const primary = screen.getByRole('navigation', { name: 'Sezioni campioni' })
    expectLinkContext(state, within(primary).getByRole('link', { name: 'Quali giochi meglio?' }), 'best', role)
    expectLinkContext(state, within(primary).getByRole('link', { name: 'Piano competitivo' }), 'tournament', role)
    const comparisons = screen.getByRole('navigation', { name: 'Confronti aggiuntivi' })
    expectLinkContext(state, within(comparisons).getByRole('link', { name: 'Avversari e alleati' }), 'matchups', role, true)
    // Constructing every link must leave the currently displayed REC URL raw.
    expect(state.router.state.location.search).toBe(state.initialSearch)

    const selectedLink = screen.getByRole('link', { name: link })
    expectLinkContext(state, selectedLink, target, role, secondary)
    await state.user.click(selectedLink)
    expect(await screen.findByRole('heading', { name: destination })).toBeVisible()
    expect(screen.getByRole('status', { name: 'Ruolo effettivo' })).toHaveTextContent(role)
    const current = new URLSearchParams(state.router.state.location.search)
    expect(current.get('role')).toBe(role)
    expect(current.get('section')).toBe(target)
    expect(current.get('queue')).toBe('RANKED_FLEX_SR')
    expect(current.get('days')).toBe('all')
  })

  it('conserva il token REC e la modalità passando a Piano di prove', async () => {
    const raw = '\u0085 adc \u001f'
    const state = setup('choices', 'discover', raw)
    const target = screen.getByRole('link', { name: 'Piano di prove' })
    const href = new URL(target.getAttribute('href')!, 'http://localhost')
    expect(href.searchParams.get('role')).toBe(raw)
    expect(href.searchParams.get('training')).toBe('plan')
    expect(href.searchParams.get('days')).toBe('0')
    for (const key of detailKeys) expect(href.searchParams.has(key)).toBe(false)
    expect(state.router.state.location.search).toBe(state.initialSearch)
    await state.user.click(target)
    expect(await screen.findByRole('heading', { name: 'Prove di catalogo' })).toBeVisible()
    expect(new URLSearchParams(state.router.state.location.search).get('role')).toBe(raw)
    expect(new URLSearchParams(state.router.state.location.search).get('days')).toBe('0')
    expect(screen.getByRole('status', { name: 'Ruolo effettivo' })).toHaveTextContent('BOTTOM')
  })

  it('mantiene la policy corrente di un bookmark diretto comune con MID', () => {
    const state = setup('best', 'plan', 'MID')
    expect(screen.getByRole('heading', { name: 'Rendimento comune' })).toBeVisible()
    expect(screen.getByRole('status', { name: 'Ruolo effettivo' })).toHaveTextContent('ALL')
    const target = screen.getByRole('link', { name: 'Piano competitivo' })
    expect(new URL(target.getAttribute('href')!, 'http://localhost').searchParams.get('role')).toBe('MID')
    expect(new URL(target.getAttribute('href')!, 'http://localhost').searchParams.get('days')).toBe('0')
    expect(new URLSearchParams(state.router.state.location.search).get('days')).toBe('0')
    expect(state.router.state.location.search).toBe(state.initialSearch)
  })
})
