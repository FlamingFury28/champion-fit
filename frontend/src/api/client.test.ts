import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildUrl, getJson, normalizeAccounts, postJson, sameAccounts, scopeQuery } from './client'

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

  it.each([null, [], ['unexpected'], 'unexpected', 42, true])('rifiuta una risposta senza oggetto API: %j', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)))
    await expect(getJson('/api/test')).rejects.toMatchObject({
      name: 'ApiError', status: 200, message: 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.',
    })
  })

  it.each(['', '{"items":'])('rende leggibile un corpo JSON incompleto: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    await expect(getJson('/api/test')).rejects.toMatchObject({
      name: 'ApiError', status: 200, message: 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.',
    })
  })

  it('non conferma né ripete un POST se manca la risposta completa', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(postJson('/api/test', { note: 'Bozza' })).rejects.toMatchObject({ name: 'ApiError', status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifica un corpo interrotto dopo la ricezione degli header', async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new TypeError('private transport detail')) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)))
    await expect(getJson('/api/test')).rejects.toMatchObject({
      name: 'ApiError', status: 200, message: 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.',
    })
  })

  it('propaga la cancellazione durante il corpo di una risposta di errore', async () => {
    const cancellation = new DOMException('Cancelled', 'AbortError')
    const stream = new ReadableStream({ start(controller) { controller.error(cancellation) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, {
      status: 409, headers: { 'Content-Type': 'application/json' },
    })))
    await expect(getJson('/api/test')).rejects.toBe(cancellation)
  })

  it('conserva la ragione esplicita della cancellazione', async () => {
    const controller = new AbortController()
    const cancellation = new Error('Draft changed')
    controller.abort(cancellation)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cancellation))
    await expect(getJson('/api/test', undefined, controller.signal)).rejects.toBe(cancellation)
  })
})
