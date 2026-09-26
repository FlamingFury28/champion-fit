import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ChampionsHubPage } from './ChampionsHubPage'

vi.mock('./ChampionDetailPage', () => ({ ChampionDetailPage: () => null }))
vi.mock('./ChampionPerformancePage', () => ({ ChampionPerformancePage: () => <h2>Rendimento competitivo</h2> }))
vi.mock('./ChampionsPage', () => ({ ChampionsPage: () => <h2>Avversari</h2> }))
vi.mock('./CompetitivePlanPage', () => ({ CompetitivePlanPage: () => <h2>Piano competitivo</h2> }))
vi.mock('./FitPage', () => ({ FitPage: () => <h2>Familiari e preferiti</h2> }))
vi.mock('./ScoutPage', () => ({ ScoutPage: () => <h2>Scopri candidati</h2> }))
vi.mock('./SynergyPage', () => ({ SynergyPage: () => <h2>Alleati</h2> }))
vi.mock('./TestPlanPage', () => ({ TestPlanPage: () => <h2>Piano breve</h2> }))

function renderHub(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/fit" element={<ChampionsHubPage />} /></Routes></MemoryRouter>)
}

afterEach(cleanup)

describe('navigazione campioni', () => {
  it('apre il rendimento per default e tiene le preferenze fuori dalle sezioni principali', () => {
    renderHub('/app/fit')
    expect(screen.getByRole('heading', { name: 'Rendimento competitivo' })).toBeVisible()
    const primary = screen.getByRole('navigation', { name: 'Sezioni campioni' })
    expect(within(primary).getByRole('link', { name: 'Quali giochi meglio?' })).toHaveAttribute('aria-current', 'page')
    expect(within(primary).getByRole('link', { name: 'Piano da 400 partite' })).toBeVisible()
    expect(within(primary).queryByRole('link', { name: 'Familiari e preferiti' })).not.toBeInTheDocument()
    expect(screen.getByText('Preferenze e scoperte')).toBeVisible()
  })

  it('mantiene accessibili le pagine preferenze e apre il gruppo sui vecchi link', () => {
    renderHub('/app/fit?section=choices')
    const secondary = screen.getByRole('navigation', { name: 'Preferenze e scoperte facoltative' })
    expect(screen.getByRole('heading', { name: 'Familiari e preferiti' })).toBeVisible()
    expect(within(secondary).getByRole('link', { name: 'Familiari e preferiti' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Preferenze e scoperte').closest('details')).toHaveAttribute('open')
  })
})
