import type { CompanionMode, ScopeQueryInput } from './types'
import { apiErrorLabel } from '../app/labels'

type QueryValue = string | number | boolean | readonly string[] | undefined | null
export type QueryInput = Record<string, QueryValue>

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface CompanionFilterState {
  name: string
  accounts: string[]
  mode: CompanionMode
  profileAccounts: string[]
}

export interface ScopeSnapshot {
  accounts: string[]
  companion: CompanionFilterState | null
  algorithmRevision?: number
}

export function normalizeAccounts(accounts: readonly string[]): string[] {
  return [...new Set(accounts.map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'it'))
}

export function sameAccounts(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeAccounts(left)
  const b = normalizeAccounts(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function scopeQuery(scope: ScopeSnapshot): ScopeQueryInput {
  const result: ScopeQueryInput = {
    account: normalizeAccounts(scope.accounts),
    algorithm_revision: scope.algorithmRevision,
  }
  const companion = scope.companion
  if (!companion) return result
  const companionAccounts = normalizeAccounts(companion.accounts)
    .filter((account) => !scope.accounts.includes(account))
  if (!companionAccounts.length || !sameAccounts(companion.profileAccounts, scope.accounts)) return result
  return {
    ...result,
    companion_account: companionAccounts,
    companion_mode: companion.mode,
  }
}

export function buildUrl(path: string, query?: QueryInput | ScopeQueryInput): string {
  const search = new URLSearchParams()
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      if (Array.isArray(value)) {
        value.forEach((item) => search.append(key, String(item)))
      } else {
        search.set(key, String(value))
      }
    })
  }
  const suffix = search.toString()
  return suffix ? `${path}?${suffix}` : path
}

async function errorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const body = await response.json() as { error?: string; message?: string }
      if (body.error) return apiErrorLabel(body.error)
      if (body.message) return apiErrorLabel(body.message)
    } catch {
      // Fall through to a stable status message.
    }
  }
  try {
    const text = await response.text()
    const readable = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (readable) return apiErrorLabel(readable.slice(0, 240))
  } catch {
    // Keep the stable status fallback below.
  }
  return response.statusText ? apiErrorLabel(response.statusText) : `Il server ha restituito un errore (${response.status}).`
}

export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  query?: QueryInput | ScopeQueryInput,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(buildUrl(path, query), {
      ...options,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'Impossibile raggiungere il server Champion Fit.')
  }
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response))
  return response.json() as Promise<T>
}

export function getJson<T>(path: string, query?: QueryInput | ScopeQueryInput, signal?: AbortSignal) {
  return requestJson<T>(path, { signal }, query)
}

export function postJson<T>(path: string, body: unknown, signal?: AbortSignal) {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

export function putJson<T>(path: string, body: unknown, signal?: AbortSignal) {
  return requestJson<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

export function patchJson<T>(path: string, body: unknown) {
  return requestJson<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteJson<T>(path: string) {
  return requestJson<T>(path, { method: 'DELETE' })
}
