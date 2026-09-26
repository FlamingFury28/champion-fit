import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import { AuditPage } from './AuditPage'

const { context } = vi.hoisted(() => ({ context: { scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true } }))
vi.mock('../app/scope', () => ({ useScope: () => context }))

function LocationProbe() { return <output data-testid="location">{useLocation().search}</output> }

function renderPage(embedded: boolean, url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.matches(context.scope, embedded ? 'all' : 'contaminated'), { items: [] })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><AuditPage embedded={embedded} /><LocationProbe /></MemoryRouter></QueryClientProvider>)
}

afterEach(cleanup)

describe('revisione partite', () => {
  it('nell’hub parte da tutte le partite e mantiene section e gli altri filtri', async () => {
    renderPage(true, '/app/matches?section=history&days=all')
    expect(screen.getByRole('heading', { level: 2, name: 'Partite e annotazioni' })).toBeInTheDocument()
    expect(screen.getByLabelText('Mostra')).toHaveValue('all')
    await userEvent.selectOptions(screen.getByLabelText('Mostra'), 'loss')
    expect(screen.getByTestId('location')).toHaveTextContent('?section=history&days=all&flag=loss')
  })

  it('mantiene contaminated come default della pagina legacy', () => {
    renderPage(false, '/app/review/audit')
    expect(screen.getByRole('heading', { level: 1, name: 'Partite e annotazioni' })).toBeInTheDocument()
    expect(screen.getByLabelText('Mostra')).toHaveValue('contaminated')
  })
})
