import { describe, expect, it } from 'vitest'
import { friendsFiltersFromParams, friendsMinimumGamesFromSettings } from './FriendsPage'

describe('default dei compagni', () => {
  it('usa la soglia globale valida e limita valori fuori intervallo', () => {
    expect(friendsMinimumGamesFromSettings(12)).toBe(12)
    expect(friendsMinimumGamesFromSettings(0)).toBe(1)
    expect(friendsMinimumGamesFromSettings('non-valido')).toBe(5)
  })

  it('mantiene una soglia URL esplicita invece di sostituirla con il default globale', () => {
    expect(friendsFiltersFromParams(new URLSearchParams('name=Lux&min_games=3'), 12)).toMatchObject({ friend_q: 'Lux', min_shared_games: 3 })
    expect(friendsFiltersFromParams(new URLSearchParams('name=Lux'), 12)).toMatchObject({ friend_q: 'Lux', min_shared_games: 12 })
  })
})
