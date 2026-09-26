import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  retrySettings: vi.fn(),
}))

vi.mock('../app/scope', () => ({
  ScopeProvider: ({ children }: { children: React.ReactNode }) => children,
  useScope: () => mocks.scope(),
}))

vi.mock('../app/algorithm-settings', () => ({
  AlgorithmSettingsProvider: ({ children }: { children: React.ReactNode }) => children,
  useAlgorithmSettings: () => ({ refetch: mocks.retrySettings }),
}))

import { ScopedOutlet, importCompletedBetween, isImportRefreshDependency, isKnownApplicationPath, pageTitleForLocation } from './AppShell'

function scopeState(overrides: Record<string, unknown> = {}) {
  return {
    accountsLoading: false,
    accountsError: null,
    scopeEmpty: false,
    scopeReady: true,
    retryAccounts: vi.fn(),
    algorithmSettingsLoading: false,
    algorithmSettingsError: null,
    ...overrides,
  }
}

function renderOutlet() {
  return render(<MemoryRouter initialEntries={['/app/overview']}><Routes><Route path="/app" element={<ScopedOutlet />}><Route path="overview" element={<p>Riepilogo pronto</p>} /></Route></Routes></MemoryRouter>)
}

describe('AppShell', () => {
  beforeEach(() => {
    mocks.scope.mockReset()
    mocks.retrySettings.mockReset()
  })

  it('riconosce solo un nuovo completamento di importazione', () => {
    const base = { mode: 'snapshot', sync_active: false, automatic_api_calls: false, checkpoint_accounts: 0, last_checkpoint_at: null, last_completed_at: '2026-09-24T10:00:00', metadata: {} } as const
    expect(importCompletedBetween(base, base)).toBe(false)
    expect(importCompletedBetween(base, { ...base, last_completed_at: '2026-09-24T10:05:00' })).toBe(true)
    expect(importCompletedBetween({ ...base, mode: 'importing' }, { ...base, last_completed_at: null })).toBe(true)
    expect(isImportRefreshDependency(['api', 'accounts'])).toBe(true)
    expect(isImportRefreshDependency(['api', 'overview', {}])).toBe(true)
    expect(isImportRefreshDependency(['api', 'sync-status'])).toBe(false)
    expect(isImportRefreshDependency(['api', 'algorithm-settings'])).toBe(false)
  })

  it('offre istruzioni server e aggiornamento quando non esistono account', async () => {
    const retryAccounts = vi.fn()
    mocks.scope.mockReturnValue(scopeState({ scopeEmpty: true, scopeReady: false, retryAccounts }))
    renderOutlet()

    expect(screen.getByText(/importazione Riot dal processo server/i)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Aggiorna account' }))
    expect(retryAccounts).toHaveBeenCalledOnce()
  })

  it('consente di ritentare il caricamento globale delle impostazioni', async () => {
    mocks.scope.mockReturnValue(scopeState({ algorithmSettingsError: new Error('offline'), scopeReady: false }))
    renderOutlet()

    expect(screen.getByRole('alert')).toHaveTextContent('offline')
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(mocks.retrySettings).toHaveBeenCalledOnce()
  })

  it('assegna il titolo corretto alle route sconosciute', () => {
    expect(pageTitleForLocation('/app/overview', '')).toBe('Riepilogo · Champion Fit')
    expect(pageTitleForLocation('/app/sconosciuta', '')).toBe('Pagina non trovata · Champion Fit')
    expect(isKnownApplicationPath('/app/fit')).toBe(true)
    expect(isKnownApplicationPath('/app/sconosciuta')).toBe(false)
  })
})
