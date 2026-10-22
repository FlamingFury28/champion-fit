import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorState } from '../components/ui'
import { ApiError, getJson } from './client'

interface ErrorEnvelope {
  name: string
  body: string
  contentType: string
  status: number
  statusText?: string
  expected: string
}

const cases: ErrorEnvelope[] = [
  { name: 'JSON error constructor', body: JSON.stringify({ error: 'constructor' }), contentType: 'application/json',
    status: 400, expected: 'constructor' },
  { name: 'JSON error __proto__', body: JSON.stringify({ error: '__proto__' }), contentType: 'application/json',
    status: 409, expected: '__proto__' },
  { name: 'JSON message Constructor con spazi originali', body: JSON.stringify({ message: '  Constructor \t' }),
    contentType: 'application/json', status: 503, expected: '  Constructor \t' },
  { name: 'testo HTML constructor senza markup',
    body: '<html><body><p>constructor</p><script>private script text</script></body></html>',
    contentType: 'text/html', status: 403, expected: 'constructor' },
  { name: 'statusText __proto__ dopo corpo vuoto', body: '', contentType: 'text/plain',
    status: 502, statusText: '__proto__', expected: '__proto__' },
  { name: 'errore noto Bad Request', body: JSON.stringify({ error: 'Bad Request' }), contentType: 'application/json',
    status: 400, expected: 'La richiesta non è valida. Controlla i dati inseriti.' },
  { name: 'errore sconosciuto conserva testo e spazi', body: JSON.stringify({ error: '  Owned unknown error \t' }),
    contentType: 'application/json', status: 422, expected: '  Owned unknown error \t' },
]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('messaggi del protocollo di errore API', () => {
  // These are accepted HTTP error envelopes, not messages attributed to a
  // current backend producer. The complete getJson/ApiError/ErrorState path
  // must keep unknown strings while translating established known messages.
  it.each(cases)('mostra $name conservando stato e possibilità di riprovare', async (fixture) => {
    const originalFixture = structuredClone(fixture)
    const response = new Response(fixture.body, {
      status: fixture.status, statusText: fixture.statusText,
      headers: { 'Content-Type': fixture.contentType },
    })
    const requests: { url: URL; method: string; headers: Headers }[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: new URL(String(input), 'http://localhost'), method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
      return response
    })
    vi.stubGlobal('fetch', fetch)
    let failure: unknown
    try {
      await getJson('/api/matches', { account: ['Owned#EUW'], role: 'ALL', queue: 'all', days: 'all', flag: 'all', limit: 24 })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ApiError)
    if (!(failure instanceof ApiError)) throw new Error('La risposta non valida deve produrre ApiError')
    expect(failure.name).toBe('ApiError')
    expect(failure.status).toBe(fixture.status)
    expect.soft(failure.message).toBe(fixture.expected)
    expect(typeof failure.message).toBe('string')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.method).toBe('GET')
    expect(request.url.pathname).toBe('/api/matches')
    expect(request.url.searchParams.getAll('account')).toEqual(['Owned#EUW'])
    for (const [name, value] of Object.entries({ role: 'ALL', queue: 'all', days: 'all', flag: 'all', limit: '24' })) {
      expect(request.url.searchParams.get(name)).toBe(value)
    }
    expect(request.headers.get('Accept')).toBe('application/json')

    const retry = vi.fn()
    render(<ErrorState error={failure} onRetry={retry} />)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'Impossibile caricare i dati' })).toBeVisible()
    const paragraph = alert.querySelector('p')!
    expect(paragraph).toBeVisible()
    // React keeps the original raw text; visual text matching would normalize
    // away the leading/trailing whitespace that this fallback must preserve.
    expect.soft(paragraph.textContent).toBe(fixture.expected)
    expect.soft(paragraph.textContent).not.toMatch(/function Object|\[object Object\]|\[native code\]/)
    expect(retry).not.toHaveBeenCalled()
    await userEvent.click(within(alert).getByRole('button', { name: 'Riprova' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(requests.map(({ method }) => method)).toEqual(['GET'])
    expect(failure.status).toBe(fixture.status)
    expect(failure.name).toBe('ApiError')
    expect(fixture).toEqual(originalFixture)
  })
})
