import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScopeProvider, PROFILE_ACCOUNTS_KEY, PROFILE_GROUPS_KEY, COMPANION_FILTER_KEY } from '../app/scope'
import { AppToastProvider } from '../components/toast'
import { ProfilePage } from './ProfilePage'

const clients: QueryClient[] = []
const accounts = ['Alpha#EUW', 'Beta#EUW'].map((account) => ({
  account, raw_games: 1, eligible_games: 1, analyzed_games: 1,
  wins: 1, games: 1, first_game: null, last_game: null,
}))

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ScopeProvider><AppToastProvider><ProfilePage /></AppToastProvider></ScopeProvider></QueryClientProvider>)
}

describe('Dati usati: feedback dei profili', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Alpha#EUW']))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: accounts })))
  })
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('un profilo interamente mancante conserva la selezione e viene dichiarato non applicato', async () => {
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Obsoleto: ['Missing#EUW'] }))
    mount()
    await screen.findByRole('button', { name: /Alpha#EUW/ })
    await userEvent.click(screen.getByRole('button', { name: /Obsoleto1 account/ }))
    await screen.findByText('Profilo non applicato')
    expect(screen.queryByText('Profilo applicato parzialmente')).toBeNull()
    expect(screen.getByRole('button', { name: /Alpha#EUW/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Beta#EUW/ })).toHaveAttribute('aria-pressed', 'false')
    expect(JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY)!)).toEqual(['Alpha#EUW'])
  })

  it('una quota esaurita conserva il nuovo profilo nella sessione senza dichiararlo salvato', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    mount()
    await screen.findByRole('button', { name: /Alpha#EUW/ })
    await userEvent.type(screen.getByRole('textbox', { name: 'Nome profilo' }), 'Sessione')
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }))
    await screen.findByText('Profilo disponibile per questa sessione')
    expect(screen.queryByText('Profilo salvato')).toBeNull()
    expect(screen.getByRole('button', { name: /Sessione1 account/ })).toBeInTheDocument()
    expect(screen.getByText('valido per questa sessione')).toBeInTheDocument()
    expect(localStorage.getItem(PROFILE_GROUPS_KEY)).toBeNull()
  })

  it('dichiara salvato il profilo soltanto dopo la scrittura riuscita nel browser', async () => {
    mount()
    await screen.findByRole('button', { name: /Alpha#EUW/ })
    await userEvent.type(screen.getByRole('textbox', { name: 'Nome profilo' }), 'Principale')
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }))
    await screen.findByText('Profilo salvato')
    await waitFor(() => expect(JSON.parse(localStorage.getItem(PROFILE_GROUPS_KEY)!)).toEqual({ Principale: ['Alpha#EUW'] }))
  })

  it('disabilita il filtro quando viene eliminato il profilo scelto e permette una nuova scelta valida', async () => {
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Duo: ['Beta#EUW'], Alternativa: ['Beta#EUW'] }))
    mount()
    const user = userEvent.setup()
    const select = await screen.findByRole('combobox', { name: 'Profilo dei compagni' })
    await screen.findByRole('option', { name: 'Duo · 1 account applicabile' })
    await user.selectOptions(select, 'Duo')
    const apply = screen.getByRole('button', { name: 'Applica filtro' })
    expect(apply).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Elimina profilo Duo' }))
    await user.click(screen.getByRole('button', { name: 'Conferma eliminazione' }))

    await waitFor(() => expect(apply).toBeDisabled())
    expect(select).toHaveValue('')
    expect(localStorage.getItem(COMPANION_FILTER_KEY)).toBeNull()

    await user.selectOptions(select, 'Alternativa')
    await user.click(apply)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(COMPANION_FILTER_KEY)!)).toMatchObject({
      name: 'Alternativa', accounts: ['Beta#EUW'], mode: 'exclude',
    }))
  })

  it('scarta una scelta che non contiene più account esterni al perimetro e applica un altro profilo valido', async () => {
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Duo: ['Beta#EUW'], Altro: ['Alpha#EUW'] }))
    mount()
    const user = userEvent.setup()
    const select = await screen.findByRole('combobox', { name: 'Profilo dei compagni' })
    await screen.findByRole('option', { name: 'Duo · 1 account applicabile' })
    await user.selectOptions(select, 'Duo')
    const apply = screen.getByRole('button', { name: 'Applica filtro' })

    await user.click(screen.getByRole('button', { name: /^Beta#EUW/ }))

    await waitFor(() => expect(apply).toBeDisabled())
    expect(select).toHaveValue('')
    expect(screen.queryByRole('option', { name: 'Duo · 1 account applicabile' })).not.toBeInTheDocument()
    expect(localStorage.getItem(COMPANION_FILTER_KEY)).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Alpha#EUW/ }))
    await user.selectOptions(select, 'Altro')
    await user.click(apply)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(COMPANION_FILTER_KEY)!)).toMatchObject({
      name: 'Altro', accounts: ['Alpha#EUW'], profile_accounts: ['Beta#EUW'],
    }))
  })
})
