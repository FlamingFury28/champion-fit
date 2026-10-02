import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { RecommendationFeedbackResponseDto } from '../api/types'
import { PreferenceEditor } from './PreferenceEditor'

const scope = { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null }
const payload: RecommendationFeedbackResponseDto = {
  revision: 4,
  accounts: ['Alpha#EUW', 'Beta#EUW'],
  suspended_accounts: [],
  unresolved_accounts: [],
  items: [
    { account: 'Alpha#EUW', champion: 'Teemo', role: 'TOP', preference: 'dislike', updated_at: '2026-10-02T10:00:00Z' },
    { account: 'Beta#EUW', champion: 'Teemo', role: 'TOP', preference: 'like', updated_at: '2026-10-02T10:01:00Z' },
  ],
  options: [
    { champion: 'Ahri', name: 'Ahri', roles: ['MIDDLE'], roles_by_account: { 'Alpha#EUW': ['MIDDLE'], 'Beta#EUW': ['MIDDLE'] }, icon_url: null, classified: true },
    { champion: 'Teemo', name: 'Teemo', roles: ['TOP'], roles_by_account: { 'Alpha#EUW': ['TOP'], 'Beta#EUW': ['TOP'] }, icon_url: null, classified: true },
    { champion: 'Zed', name: 'Zed', roles: ['MIDDLE'], roles_by_account: { 'Alpha#EUW': ['MIDDLE'], 'Beta#EUW': ['MIDDLE'] }, icon_url: null, classified: true },
    { champion: 'Future Hero', name: 'Future Hero', roles: [], roles_by_account: { 'Alpha#EUW': ['TOP'], 'Beta#EUW': [] }, icon_url: null, classified: false },
  ],
  catalog_version: 'test',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function setup(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { user: userEvent.setup(), client, ...render(<QueryClientProvider client={client}><PreferenceEditor scope={scope} /></QueryClientProvider>) }
}

afterEach(() => vi.unstubAllGlobals())

describe('PreferenceEditor', () => {
  it('salva un campione del catalogo fuori dalle proposte con account espliciti', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const { user } = setup((input, init) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(response(init?.method === 'POST' ? { revision: 5 } : { ...payload, revision: init?.method === 'POST' ? 5 : 4 }))
    })
    await screen.findByRole('option', { name: 'Zed' })
    await user.type(screen.getByLabelText('Cerca nel catalogo'), 'Zed')
    await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Zed')
    expect(await screen.findByRole('option', { name: 'Corsia centrale' })).toBeVisible()
    await user.click(screen.getByText('Account · 2/2 selezionati'))
    await user.click(screen.getByRole('checkbox', { name: 'Beta#EUW' }))
    expect(screen.getByText('Account · 1/2 selezionati')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Mi piace$/ }))
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'POST')).toBe(true))
    const body = JSON.parse(String(calls.find((call) => call.init?.method === 'POST')?.init?.body))
    expect(body).toEqual({ accounts: ['Alpha#EUW'], champion: 'Zed', role: 'MIDDLE', preference: 'like', expected_revision: 4 })
  })

  it('mantiene visibile un dislike escluso e lo reimposta per il solo account della riga', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const { user } = setup((input, init) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(response(init?.method === 'POST' ? { revision: 5 } : payload))
    })
    const ledgerRegion = await screen.findByRole('region', { name: 'Registro delle preferenze dichiarate' })
    const ledger = within(ledgerRegion).getByRole('table')
    const row = within(ledger).getByRole('row', { name: /Teemo.*Corsia superiore.*Alpha#EUW.*Non fa per me/ })
    await user.click(within(row).getByRole('button', { name: 'Imposta Neutro' }))
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'POST')).toBe(true))
    expect(JSON.parse(String(calls.find((call) => call.init?.method === 'POST')?.init?.body))).toEqual({
      accounts: ['Alpha#EUW'], champion: 'Teemo', role: 'TOP', preference: 'neutral', expected_revision: 4,
    })
  })

  it('ricalcola i ruoli di un campione sconosciuto sul sottoinsieme destinatario', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const { user } = setup((input, init) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(response(init?.method === 'POST' ? { revision: 5 } : payload))
    })
    await screen.findByRole('option', { name: 'Future Hero · senza classificazione' })
    await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Future Hero')
    expect(screen.getByLabelText('Ruolo della preferenza')).toBeDisabled()

    await user.click(screen.getByText('Account · 2/2 selezionati'))
    await user.click(screen.getByRole('checkbox', { name: 'Beta#EUW' }))
    await user.selectOptions(screen.getByLabelText('Ruolo della preferenza'), 'TOP')
    await user.click(screen.getByRole('button', { name: /^Mi piace$/ }))

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'POST')).toBe(true))
    expect(JSON.parse(String(calls.find((call) => call.init?.method === 'POST')?.init?.body))).toEqual({
      accounts: ['Alpha#EUW'], champion: 'Future Hero', role: 'TOP', preference: 'like', expected_revision: 4,
    })
  })

  it('invalida anche i registri in cache di altri scope dopo un salvataggio', async () => {
    const { user, client } = setup((_input, init) => Promise.resolve(response(init?.method === 'POST' ? { revision: 5 } : payload)))
    const otherScope = { accounts: ['Gamma#EUW'], companion: null }
    const otherKey = queryKeys.recommendationFeedback(otherScope)
    client.setQueryData(otherKey, { ...payload, accounts: ['Gamma#EUW'], revision: 4 })

    await screen.findByRole('option', { name: 'Ahri' })
    await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Ahri')
    await user.click(screen.getByRole('button', { name: /^Mi piace$/ }))

    await waitFor(() => expect(client.getQueryState(otherKey)?.isInvalidated).toBe(true))
  })

  it('mostra separatamente stati diversi dello stesso campione per account', async () => {
    setup(() => Promise.resolve(response(payload)))
    const ledger = await screen.findByRole('region', { name: 'Registro delle preferenze dichiarate' })
    expect(within(ledger).getByRole('row', { name: /Teemo.*Alpha#EUW.*Non fa per me/ })).toBeVisible()
    expect(within(ledger).getByRole('row', { name: /Teemo.*Beta#EUW.*Mi piace/ })).toBeVisible()
  })

  it('ricarica registro e suggerimenti dopo un conflitto CAS', async () => {
    let gets = 0
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') return Promise.resolve(response({ error: 'revision conflict' }, 409))
      gets += 1
      return Promise.resolve(response({ ...payload, revision: gets === 1 ? 4 : 5 }))
    })
    await screen.findByRole('option', { name: 'Ahri' })
    await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Ahri')
    await user.click(screen.getByRole('button', { name: /^Mi piace$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Ho ricaricato il registro corrente')
    await waitFor(() => expect(gets).toBeGreaterThan(1))
  })

  it('azzera una scelta che la ricerca rende invisibile e impedisce il salvataggio', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const { user } = setup((input, init) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(response(payload))
    })
    await screen.findByRole('option', { name: 'Ahri' })
    await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Ahri')
    expect(screen.getByLabelText('Ruolo della preferenza')).toHaveValue('MIDDLE')
    await user.type(screen.getByLabelText('Cerca nel catalogo'), 'Zed')
    await waitFor(() => expect(screen.getByLabelText('Campione della preferenza')).toHaveValue(''))
    expect(screen.getByLabelText('Ruolo della preferenza')).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Mi piace$/ })).toBeDisabled()
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false)
  })

  it('nasconde subito il registro precedente durante un cambio rapido di scope', async () => {
    const pending = new Promise<Response>(() => undefined)
    const { client, rerender } = setup((input) => String(input).includes('account=Beta%23EUW') && !String(input).includes('account=Alpha%23EUW')
      ? pending
      : Promise.resolve(response({ ...payload, accounts: ['Alpha#EUW'] })))
    expect(await screen.findByRole('option', { name: 'Zed' })).toBeVisible()
    rerender(<QueryClientProvider client={client}><PreferenceEditor scope={{ accounts: ['Beta#EUW'], companion: null }} /></QueryClientProvider>)
    expect(screen.queryByRole('option', { name: 'Zed' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Caricamento delle preferenze' })).toBeVisible()
  })
})
