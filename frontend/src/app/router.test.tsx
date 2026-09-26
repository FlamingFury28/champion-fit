import { render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { RouteErrorBoundary, notFoundRoute } from './router'

afterEach(() => { document.title = '' })

describe('router', () => {
  it('mostra un recupero esplicito quando una route non viene caricata', async () => {
    const router = createMemoryRouter([{
      path: '/',
      loader: () => { throw new Error('chunk non disponibile') },
      element: <p>pagina</p>,
      errorElement: <RouteErrorBoundary />,
    }])
    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('chunk non disponibile')
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeVisible()
    await waitFor(() => expect(document.title).toBe('Errore di caricamento · Champion Fit'))
  })

  it('imposta il titolo 404 anche fuori dalla shell applicativa', async () => {
    const lazyRoute = await notFoundRoute()
    const NotFound = lazyRoute.Component
    const router = createMemoryRouter([{ path: '*', element: <NotFound /> }], { initialEntries: ['/assente'] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('heading', { name: 'Pagina non trovata' })).toBeVisible()
    await waitFor(() => expect(document.title).toBe('Pagina non trovata · Champion Fit'))
  })
})
