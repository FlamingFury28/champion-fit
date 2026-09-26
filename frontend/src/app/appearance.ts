import { useSyncExternalStore } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
export type AccentPreference = 'mint' | 'sky' | 'amber'
export type DensityPreference = 'comfortable' | 'compact'

export interface AppearancePreferences {
  theme: ThemePreference
  accent: AccentPreference
  density: DensityPreference
}

interface AppearanceSnapshot {
  preferences: AppearancePreferences
  resolvedTheme: 'dark' | 'light'
  storageAvailable: boolean
}

export const APPEARANCE_STORAGE_KEY = 'champion-fit:appearance:v1'
export const DEFAULT_APPEARANCE: Readonly<AppearancePreferences> = {
  theme: 'dark', accent: 'mint', density: 'comfortable',
}

function normalizePreferences(value: unknown): AppearancePreferences {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  return {
    theme: candidate.theme === 'light' || candidate.theme === 'system' ? candidate.theme : 'dark',
    accent: candidate.accent === 'sky' || candidate.accent === 'amber' ? candidate.accent : 'mint',
    density: candidate.density === 'compact' ? 'compact' : 'comfortable',
  }
}

export function parseAppearance(value: string | null): AppearancePreferences {
  try { return normalizePreferences(JSON.parse(value ?? 'null')) }
  catch { return { ...DEFAULT_APPEARANCE } }
}

/** A separate instance makes recovery and browser lifecycle behavior testable. */
export function createAppearanceStore() {
  let snapshot: AppearanceSnapshot = {
    preferences: { ...DEFAULT_APPEARANCE }, resolvedTheme: 'dark', storageAvailable: true,
  }
  let initialized = false
  let systemTheme: MediaQueryList | undefined
  const listeners = new Set<() => void>()

  function publish(preferences: AppearancePreferences, storageAvailable = snapshot.storageAvailable) {
    const resolvedTheme = preferences.theme === 'system'
      ? (systemTheme?.matches ?? true) ? 'dark' : 'light'
      : preferences.theme
    if (typeof document !== 'undefined') {
      const root = document.documentElement
      root.dataset.theme = resolvedTheme
      root.dataset.accent = preferences.accent
      root.dataset.density = preferences.density
      root.style.colorScheme = resolvedTheme
    }
    const previous = snapshot.preferences
    if (previous.theme === preferences.theme && previous.accent === preferences.accent
      && previous.density === preferences.density && snapshot.resolvedTheme === resolvedTheme
      && snapshot.storageAvailable === storageAvailable) return
    snapshot = { preferences, resolvedTheme, storageAvailable }
    listeners.forEach((listener) => listener())
  }

  function onSystemChange() {
    if (snapshot.preferences.theme === 'system') publish(snapshot.preferences)
  }

  function onStorage(event: StorageEvent) {
    if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) {
      publish(parseAppearance(event.newValue))
    }
  }

  function initialize() {
    if (initialized || typeof window === 'undefined') return
    initialized = true
    if (typeof window.matchMedia === 'function') {
      systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
      systemTheme.addEventListener('change', onSystemChange)
    }
    window.addEventListener('storage', onStorage)
    try { publish(parseAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)), true) }
    catch { publish({ ...DEFAULT_APPEARANCE }, false) }
  }

  function updatePreferences(update: Partial<AppearancePreferences>) {
    initialize()
    const preferences = normalizePreferences({ ...snapshot.preferences, ...update })
    let storageAvailable = true
    try { window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences)) }
    catch { storageAvailable = false }
    publish(preferences, storageAvailable)
  }

  function resetPreferences() {
    initialize()
    let storageAvailable = true
    try { window.localStorage.removeItem(APPEARANCE_STORAGE_KEY) }
    catch { storageAvailable = false }
    publish({ ...DEFAULT_APPEARANCE }, storageAvailable)
  }

  return {
    initialize, updatePreferences, resetPreferences,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      initialize()
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      systemTheme?.removeEventListener('change', onSystemChange)
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
      listeners.clear()
      initialized = false
      systemTheme = undefined
    },
  }
}

const appearanceStore = createAppearanceStore()

/** Call before rendering React so restored colors are applied on the first paint. */
export const initializeAppearance = appearanceStore.initialize

export function useAppearance() {
  const snapshot = useSyncExternalStore(appearanceStore.subscribe, appearanceStore.getSnapshot, appearanceStore.getSnapshot)
  return {
    ...snapshot,
    updatePreferences: appearanceStore.updatePreferences,
    resetPreferences: appearanceStore.resetPreferences,
  }
}
