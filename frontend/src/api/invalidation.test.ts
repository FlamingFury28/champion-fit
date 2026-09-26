import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { invalidateAfterAnnotation, invalidateAfterFriendGroup, isAnnotationDependency } from './invalidation'
import { queryKeys } from './queries'

describe('invalidazioni mutation', () => {
  it('include tutte e sole le analisi dipendenti dalle annotazioni', () => {
    for (const resource of ['overview', 'profile', 'champions', 'champion', 'matchups', 'synergy', 'matches', 'blacklist', 'recommendation-evidence', 'playstyles', 'playstyle-evidence', 'recommendations']) {
      expect(isAnnotationDependency(['api', resource])).toBe(true)
    }
    expect(isAnnotationDependency(['api', 'friends'])).toBe(false)
    expect(isAnnotationDependency(['api', 'screen'])).toBe(false)
  })

  it('invalida Friends dopo una mutation friend-group', async () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    await invalidateAfterFriendGroup(client)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['api', 'friends'] })
  })

  it('usa un predicato per le invalidazioni annotation', async () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    await invalidateAfterAnnotation(client)
    const options = spy.mock.calls[0]?.[0]
    expect(options).toEqual(expect.objectContaining({ predicate: expect.any(Function) }))
  })

  it('rilegge Synergy al ritorno da Audit dopo una mutation anche se la cache è ancora fresca', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    const scope = { accounts: ['Alpha#EUW'], companion: null }
    const key = queryKeys.synergy(scope, 'ALL', { minReliability: 'weak', includeExploratory: false })
    let negativeEvidence = 1
    const fetchSynergy = vi.fn(async () => ({ negativeEvidence }))
    const options = { queryKey: key, queryFn: fetchSynergy }
    let unsubscribe: (() => void) | undefined

    try {
      await client.fetchQuery(options)
      client.setQueryData(['api', 'friends'], { unchanged: true })
      expect(client.getQueryData(key)).toEqual({ negativeEvidence: 1 })

      // Audit mounts after Synergy has unmounted: its cached query is inactive.
      const annotation = client.getMutationCache().build(client, {
        mutationFn: async (body: { afk_player: boolean }) => {
          negativeEvidence = body.afk_player ? 0 : 1
          return { ok: true }
        },
        onSuccess: () => invalidateAfterAnnotation(client),
      })
      await annotation.execute({ afk_player: true })

      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
      expect(client.getQueryState(['api', 'friends'])?.isInvalidated).toBe(false)
      expect(fetchSynergy).toHaveBeenCalledTimes(1)

      // Returning to Synergy observes the same key and must fetch fresh evidence.
      const returnedPage = new QueryObserver(client, options)
      unsubscribe = returnedPage.subscribe(() => {})
      await vi.waitFor(() => {
        expect(returnedPage.getCurrentResult().data).toEqual({ negativeEvidence: 0 })
      })
      expect(fetchSynergy).toHaveBeenCalledTimes(2)
      expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    } finally {
      unsubscribe?.()
      client.clear()
    }
  })
})
