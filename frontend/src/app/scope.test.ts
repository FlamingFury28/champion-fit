import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountDto } from '../api/types'
import { COMPANION_FILTER_KEY, PROFILE_ACCOUNTS_KEY, PROFILE_GROUPS_KEY, createInitialScopeState, mergeProfileChanges, resolveScopeIdentities, scopeReducer } from './scope'

function account(account: string, aliases: string[] = []): AccountDto {
  return { account, aliases, raw_games: 0, eligible_games: 0, analyzed_games: 0,
    wins: 0, games: 0, first_game: null, last_game: null }
}

describe('scope reducer e persistenza legacy', () => {
  beforeEach(() => localStorage.clear())

  it('legge le chiavi browser esistenti e normalizza i dati', () => {
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Beta#EUW', 'Alpha#EUW', 'Beta#EUW']))
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Main: ['Alpha#EUW'] }))
    localStorage.setItem(COMPANION_FILTER_KEY, JSON.stringify({ name: 'Duo', accounts: ['Gamma#EUW'], mode: 'exclude', profile_accounts: ['Alpha#EUW', 'Beta#EUW'] }))
    expect(createInitialScopeState()).toEqual({
      accounts: ['Alpha#EUW', 'Beta#EUW'],
      profiles: { Main: ['Alpha#EUW'] },
      companion: { name: 'Duo', accounts: ['Gamma#EUW'], mode: 'exclude', profileAccounts: ['Alpha#EUW', 'Beta#EUW'] },
    })
  })

  it('ignora JSON valido con una forma incompatibile senza bloccare il boot', () => {
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify({ account: 'Alpha#EUW' }))
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(['Main']))
    expect(createInitialScopeState()).toEqual({ accounts: [], profiles: {}, companion: null })
  })

  it('invalida il companion quando cambia account', () => {
    const initial = {
      accounts: ['Alpha#EUW'], profiles: {},
      companion: { name: 'Duo', accounts: ['Gamma#EUW'], mode: 'only' as const, profileAccounts: ['Alpha#EUW'] },
    }
    expect(scopeReducer(initial, { type: 'set-accounts', accounts: ['Beta#EUW'] }).companion).toBeNull()
  })

  it('non muta lo stato quando la selezione canonica è equivalente', () => {
    const initial = { accounts: ['Alpha#EUW', 'Beta#EUW'], profiles: {}, companion: null }
    expect(scopeReducer(initial, { type: 'set-accounts', accounts: ['Beta#EUW', 'Alpha#EUW'] })).toBe(initial)
  })

  it('salva e rimuove profili locali', () => {
    const initial = { accounts: ['Alpha#EUW'], profiles: {}, companion: null }
    const saved = scopeReducer(initial, { type: 'save-profile', name: 'Main', accounts: ['Alpha#EUW'] })
    expect(saved.profiles.Main).toEqual(['Alpha#EUW'])
    expect(scopeReducer(saved, { type: 'delete-profile', name: 'Main' }).profiles).toEqual({})
  })

  it('unisce modifiche indipendenti da schede diverse e conserva il profilo locale in conflitto', () => {
    const baseline = { Principale: ['Alpha#EUW'] }
    expect(mergeProfileChanges(
      { ...baseline, Mio: ['Beta#EUW'] },
      { ...baseline, AltraScheda: ['Gamma#EUW'] },
      baseline,
    )).toEqual({ Principale: ['Alpha#EUW'], Mio: ['Beta#EUW'], AltraScheda: ['Gamma#EUW'] })
    expect(mergeProfileChanges(
      { Principale: ['Beta#EUW'] },
      { Principale: ['Gamma#EUW'] },
      baseline,
    )).toEqual({ Principale: ['Beta#EUW'] })
  })

  it('propaga una cancellazione se l’altra scheda non ha modificato quel profilo', () => {
    const baseline = { Principale: ['Alpha#EUW'] }
    expect(mergeProfileChanges({}, baseline, baseline)).toEqual({})
  })

  it('risolve NFKC, maiuscole e casefold comune senza perdere profili o companion', () => {
    const initial = {
      accounts: ['ＯＬＤ#ＥＵＷ'], profiles: { Main: ['ＯＬＤ#ＥＵＷ'], Duo: ['STRASSE#euw'] },
      companion: { name: 'Duo', accounts: ['STRASSE#euw'], mode: 'only' as const, profileAccounts: ['ＯＬＤ#ＥＵＷ'] },
    }
    const catalog = [account('New#EUW', ['Old#EUW']), account('Duo#EUW', ['Straße#EUW']), account('Other#EUW')]
    const resolved = resolveScopeIdentities(initial, catalog)
    expect(resolved).toEqual({
      accounts: ['New#EUW'], profiles: { Main: ['New#EUW'], Duo: ['Duo#EUW'] },
      companion: { name: 'Duo', accounts: ['Duo#EUW'], mode: 'only', profileAccounts: ['New#EUW'] },
    })
    expect(resolveScopeIdentities(resolved, catalog)).toBe(resolved)
  })

  it('dà precedenza al nome attuale anche se è alias storico di un altro account', () => {
    const initial = { accounts: ['old#euw'], profiles: {}, companion: null }
    expect(resolveScopeIdentities(initial, [account('New#EUW', ['Old#EUW']), account('Old#EUW')]).accounts)
      .toEqual(['Old#EUW'])
  })

  it('mantiene la selezione esplicita se un alias è ambiguo o manca dal catalogo', () => {
    const catalog = [account('New#EUW', ['Old#EUW']), account('Other#EUW', ['Old#EUW'])]
    for (const selected of ['Old#EUW', 'Missing#EUW']) {
      const initial = { accounts: [selected], profiles: { Main: [selected] }, companion: null }
      expect(resolveScopeIdentities(initial, catalog)).toBe(initial)
    }
    expect(resolveScopeIdentities({ accounts: [], profiles: {}, companion: null }, catalog).accounts)
      .toEqual(['New#EUW', 'Other#EUW'])
  })
})
