import { useState } from 'react'
import { useSearchParams } from 'react-router'

interface RememberedFiltersOptions<T extends Record<keyof T, string>> {
  storageKey: string
  defaults: T
  parse: (params: URLSearchParams) => T
  validSavedValue: (key: keyof T, value: string) => boolean
  aliases?: readonly string[]
  keepExplicitKeys?: readonly (keyof T)[]
}

function readSaved<T extends Record<keyof T, string>>(options: RememberedFiltersOptions<T>) {
  let raw: string | null
  try { raw = localStorage.getItem(options.storageKey) }
  catch { return { filters: options.defaults, storageAvailable: false } }
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    const values = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {}
    const params = new URLSearchParams()
    ;(Object.keys(options.defaults) as Array<Extract<keyof T, string>>).forEach((key) => {
      const value = values[key]
      if (typeof value === 'string' && value !== options.defaults[key] && options.validSavedValue(key, value)) params.set(key, value)
    })
    return { filters: options.parse(params), storageAvailable: true }
  } catch { return { filters: options.defaults, storageAvailable: true } }
}

export function useRememberedFilters<T extends Record<keyof T, string>>(options: RememberedFiltersOptions<T>) {
  const [params, setParams] = useSearchParams()
  const [saved, setSaved] = useState(() => readSaved(options))
  const keys = Object.keys(options.defaults) as Array<Extract<keyof T, string>>
  const hasLinkFilters = [...keys, ...options.aliases ?? []].some((key) => params.has(key))
  // Explicit links define their whole context. Missing link fields use defaults,
  // never preferences inherited from another visit or another browser.
  const filters = hasLinkFilters ? options.parse(params) : saved.filters

  function updateFilters(update: Partial<T>) {
    const nextFilters = { ...filters, ...update }
    let storageAvailable = true
    try { localStorage.setItem(options.storageKey, JSON.stringify(nextFilters)) }
    catch { storageAvailable = false }
    setSaved({ filters: nextFilters, storageAvailable })
    setParams((current) => {
      const next = new URLSearchParams(current)
      // Materialize remembered context on the first edit; otherwise preserve
      // unrelated parameters and the original spelling of untouched link fields.
      const changed = hasLinkFilters ? Object.keys(update) as typeof keys : keys
      changed.forEach((key) => {
        if (nextFilters[key] === options.defaults[key] && !options.keepExplicitKeys?.includes(key)) next.delete(key)
        else next.set(key, nextFilters[key])
      })
      return next
    }, { replace: true })
  }

  return { filters, updateFilters, storageAvailable: saved.storageAvailable }
}
