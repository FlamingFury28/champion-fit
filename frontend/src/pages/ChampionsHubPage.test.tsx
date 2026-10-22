import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { ChampionsHubPage } from './ChampionsHubPage'

vi.mock('./ChampionDetailPage', () => ({ ChampionDetailPage: () => null }))
vi.mock('./ChampionPerformancePage', () => ({ ChampionPerformancePage: () => <h2>Rendimento competitivo</h2> }))
vi.mock('./ChampionsPage', () => ({ ChampionsPage: () => <h2>Avversari</h2> }))
vi.mock('./CompetitivePlanPage', () => ({ CompetitivePlanPage: () => <h2>Piano competitivo</h2> }))
vi.mock('./FitPage', () => ({ FitPage: () => <h2>Familiari e preferiti</h2> }))
vi.mock('./ScoutPage', () => ({ ScoutPage: () => <h2>Scopri candidati</h2> }))
vi.mock('./SynergyPage', () => ({ SynergyPage: () => <h2>Alleati</h2> }))
vi.mock('./TestPlanPage', () => ({ TestPlanPage: () => <h2>Piano breve</h2> }))

function LocationSearch() {
  return <output data-testid="route-search">{useLocation().search}</output>
}

function renderHub(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/fit" element={<><ChampionsHubPage /><LocationSearch /></>} /></Routes></MemoryRouter>)
}

afterEach(cleanup)

describe('navigazione campioni', () => {
  it('apre il rendimento per default e tiene le preferenze fuori dalle sezioni principali', () => {
    renderHub('/app/fit')
    expect(screen.getByRole('heading', { name: 'Rendimento competitivo' })).toBeVisible()
    const primary = screen.getByRole('navigation', { name: 'Sezioni campioni' })
    expect(within(primary).getByRole('link', { name: 'Quali giochi meglio?' })).toHaveAttribute('aria-current', 'page')
    expect(within(primary).getByRole('link', { name: 'Piano competitivo' })).toBeVisible()
    expect(within(primary).queryByRole('link', { name: 'Avversari e alleati' })).not.toBeInTheDocument()
    expect(within(primary).queryByRole('link', { name: 'Familiari e preferiti' })).not.toBeInTheDocument()
    expect(screen.getByText('Altri strumenti')).toBeVisible()
  })

  it('mantiene accessibili le pagine preferenze e apre il gruppo sui vecchi link', () => {
    renderHub('/app/fit?section=choices')
    const secondary = screen.getByRole('navigation', { name: 'Preferenze e scoperte facoltative' })
    expect(screen.getByRole('heading', { name: 'Familiari e preferiti' })).toBeVisible()
    expect(within(secondary).getByRole('link', { name: 'Familiari e preferiti' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Altri strumenti').closest('details')).toHaveAttribute('open')
  })

  it('chiudere una scheda aperta da URL elimina il contesto del drawer e conserva i filtri della lista', async () => {
    renderHub('/app/fit?section=best&search=Ahri&detail=Ahri&detailRole=MIDDLE&detailQueue=420&detailDays=180')
    await userEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(screen.getByTestId('route-search')).toHaveTextContent('?section=best&search=Ahri')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('i link alle sezioni aggiuntive non trascinano il contesto della scheda', () => {
    renderHub('/app/fit?section=choices&search=Ahri&detailRole=MIDDLE&detailQueue=420&detailDays=180')
    expect(screen.getByRole('link', { name: 'Scopri candidati' })).toHaveAttribute('href', '/app/fit?section=training&search=Ahri&training=discover')
    const primary = screen.getByRole('navigation', { name: 'Sezioni campioni' })
    expect(within(primary).getByRole('link', { name: 'Quali giochi meglio?' })).toHaveAttribute('href', '/app/fit?section=best&search=Ahri')
  })
})
