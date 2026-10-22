import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { MatchDto } from '../api/types'
import { AuditPage } from './AuditPage'

const { scope } = vi.hoisted(() => ({ scope: { accounts: ['Alpha#EUW'], companion: null } }))
vi.mock('../app/scope', () => ({ useScope: () => ({ scope, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const clients: QueryClient[] = []
function setup(date: string, dateUtc?: string | null) {
  const match: MatchDto = {
    id: 1, account: 'Alpha#EUW', match_id: 'MATCH-CANONICAL', date, date_utc: dateUtc,
    patch: '16.1', queue: '420', champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'test',
    duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0, early_surrender: 0,
    anomaly_flags: 'none', match_quality_score: 0.95, loss_attribution_weight: 0.95,
    win_evidence_weight: 0, reason: 'test', icon_url: '', annotation_invincible: 0,
    annotation_carryable_loss: 0, annotation_afk_player: 0, annotation_griefer: 0,
    annotation_team_collapse: 0, annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.matches(scope, 'all'), { items: [match] })
  client.setQueryData(queryKeys.annotation(match.match_id), { item: null, revision: null })
  const router = createMemoryRouter([{ path: '*', element: <AuditPage embedded /> }])
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { user: userEvent.setup(), match }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('date canoniche nella revisione delle partite', () => {
  it.each([
    { format: 'compact', timezone: 'UTC', raw: '20261017T003000+0200', canonical: '2026-10-16T22:30:00.000000+00:00', expected: '16/10/2026' },
    { format: 'compact', timezone: 'Europe/Rome', raw: '20261017T003000+0200', canonical: '2026-10-16T22:30:00.000000+00:00', expected: '17/10/2026' },
    { format: 'week', timezone: 'UTC', raw: '2026-W01-1T013000+0200', canonical: '2025-12-28T23:30:00.000000+00:00', expected: '28/12/2025' },
    { format: 'week', timezone: 'Europe/Rome', raw: '2026-W01-1T013000+0200', canonical: '2025-12-28T23:30:00.000000+00:00', expected: '29/12/2025' },
  ])('mostra $format in $timezone nella riga, nel nome accessibile e nell’annotazione', async ({ timezone, raw, canonical, expected }) => {
    vi.stubEnv('TZ', timezone)
    const { user, match } = setup(raw, canonical)
    const row = screen.getByRole('button', { name: /^Apri annotazione:/ })

    expect(row).toHaveTextContent(expected)
    expect(row).toHaveAccessibleName(new RegExp(expected))
    expect(row).not.toHaveTextContent(raw)
    expect(row.getAttribute('aria-label')).not.toContain(raw)

    await user.click(row)
    const dialog = await screen.findByRole('dialog', { name: 'Annotazione della partita' })
    expect(within(dialog).getByText(`Alpha#EUW · ${expected}`)).toBeVisible()
    expect(dialog).not.toHaveTextContent(raw)
    expect(match.date).toBe(raw)
  })

  it.each([undefined, null])('mantiene il fallback leggibile quando date_utc è %s', async (dateUtc) => {
    vi.stubEnv('TZ', 'UTC')
    const { user } = setup('2026-10-17T12:00:00Z', dateUtc)
    const row = screen.getByRole('button', { name: /^Apri annotazione:/ })
    expect(row).toHaveTextContent('17/10/2026')
    expect(row).toHaveAccessibleName(/17\/10\/2026/)

    await user.click(row)
    const dialog = await screen.findByRole('dialog', { name: 'Annotazione della partita' })
    expect(within(dialog).getByText('Alpha#EUW · 17/10/2026')).toBeVisible()
  })
})
