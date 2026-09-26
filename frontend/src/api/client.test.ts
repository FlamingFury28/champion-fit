import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildUrl, getJson, normalizeAccounts, sameAccounts, scopeQuery } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('API client', () => {
  it('normalizza, deduplica e ordina gli account', () => {
    expect(normalizeAccounts([' Beta#EUW ', 'Alpha#EUW', 'Beta#EUW', ''])).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(sameAccounts(['Beta#EUW', 'Alpha#EUW'], ['Alpha#EUW', 'Beta#EUW'])).toBe(true)
  })

  it('serializza scope e account come query parameter ripetuti', () => {
    const url = buildUrl('/api/overview', {
      account: ['Alpha#EUW', 'Beta#EUW'],
      companion_account: ['Gamma#EUW'],
      companion_mode: 'exclude',
    })
    const parsed = new URL(url, 'http://local.test')
    expect(parsed.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(parsed.searchParams.getAll('companion_account')).toEqual(['Gamma#EUW'])
    expect(parsed.searchParams.get('companion_mode')).toBe('exclude')
  })

  it('scarta un companion incompatibile con il profilo attivo', () => {
    expect(scopeQuery({
      accounts: ['Alpha#EUW'],
      companion: { name: 'Team', accounts: ['Gamma#EUW'], mode: 'only', profileAccounts: ['Beta#EUW'] },
    })).toEqual({ account: ['Alpha#EUW'] })
  })

  it('interpreta errori JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'scope non valido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(getJson('/api/test')).rejects.toEqual(expect.objectContaining({ status: 400, name: 'ApiError', message: 'La selezione dei dati non è valida.' }))
  })

  it('rende leggibile un errore HTML senza esporre markup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><title>Errore</title><body>Endpoint assente</body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })))
    await expect(getJson('/api/test')).rejects.toMatchObject({ status: 404, message: 'Errore Endpoint assente' })
  })

  it('propaga AbortSignal alle GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await getJson('/api/test', undefined, controller.signal)
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }))
  })
})
