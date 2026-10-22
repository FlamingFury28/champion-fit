import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { AlgorithmSettingsResponseDto } from '../api/types'
import { RECOMMENDED_ALGORITHM_SETTINGS } from './algorithm-settings'
import { queryClient } from './query-client'

const settingsKey = ['api', 'algorithm-settings'] as const
function snapshot(revision: number): AlgorithmSettingsResponseDto {
  return {
    revision, fingerprint: `synthetic-${revision}`, settings: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), history: [],
    schema: [{ path: 'recommendations.trial_budget', type: 'integer', label: 'Budget di prova', description: 'Fixture sintetica.', group: 'Raccomandazioni', min: 1, max: 10 }],
  }
}

async function conflict(key = 'sync-status', status = 409) {
  await expect(queryClient.fetchQuery({
    queryKey: ['api', key], retry: false,
    queryFn: async () => { throw new ApiError(status, 'Synthetic conflict') },
  })).rejects.toMatchObject({ status })
}

beforeEach(() => {
  queryClient.clear()
  queryClient.setQueryData(settingsKey, snapshot(2))
})
afterEach(() => { queryClient.clear(); vi.unstubAllGlobals() })

describe('decoder nel recupero globale della configurazione', () => {
  it('conserva la snapshot valida quando il recupero dopo409 restituisce200 incompleto, senza retry automatico', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    await conflict()
    await vi.waitFor(() => expect(queryClient.getQueryState(settingsKey)?.fetchStatus).toBe('idle'))
    expect(queryClient.getQueryData(settingsKey)).toEqual(snapshot(2))
    expect(queryClient.getQueryState(settingsKey)?.error).toMatchObject({ name: 'ApiError', status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aggiorna la cache solo con un documento completo validato', async () => {
    const fresh = snapshot(3)
    const fetchMock = vi.fn().mockResolvedValue(Response.json(fresh))
    vi.stubGlobal('fetch', fetchMock)
    await conflict()
    await vi.waitFor(() => expect(queryClient.getQueryData(settingsKey)).toEqual(fresh))
    expect(queryClient.getQueryState(settingsKey)?.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('non avvia un secondo recupero se anche il GET delle impostazioni restituisce409', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'Configuration changed' }, { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    await conflict()
    await vi.waitFor(() => expect(queryClient.getQueryState(settingsKey)?.error).toMatchObject({ status: 409 }))
    expect(queryClient.getQueryData(settingsKey)).toEqual(snapshot(2))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propaga il segnale e conserva la cache se il recupero viene annullato', async () => {
    let signal: AbortSignal | null | undefined
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal
      signal?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    await conflict()
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    await queryClient.cancelQueries({ queryKey: settingsKey })
    expect(signal!.aborted).toBe(true)
    expect(queryClient.getQueryData(settingsKey)).toEqual(snapshot(2))
    expect(queryClient.getQueryState(settingsKey)?.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('deduplica il recupero di conflitti simultanei in un solo GET', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((release) => { resolve = release })
    const fetchMock = vi.fn().mockReturnValue(pending)
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([conflict('profile'), conflict('recommendations')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolve(Response.json(snapshot(3)))
    await vi.waitFor(() => expect(queryClient.getQueryData(settingsKey)).toEqual(snapshot(3)))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('non ricarica le impostazioni per errori diversi da409', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await conflict('profile', 503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(settingsKey)).toEqual(snapshot(2))
  })
})
