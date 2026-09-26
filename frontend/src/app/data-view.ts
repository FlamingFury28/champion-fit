import { useSyncExternalStore } from 'react'

export type DataViewPreference = 'list' | 'cards' | 'bars' | 'scatter' | 'radar'

export const DATA_VIEW_STORAGE_KEY = 'champion-fit:data-view:v2'
export const DATA_VIEW_OPTIONS: readonly { value: DataViewPreference; label: string; description: string }[] = [
  { value: 'list', label: 'Elenco', description: 'Tabelle ed elenchi con tutti i dettagli.' },
  { value: 'cards', label: 'Schede', description: 'Un riquadro per elemento, con numeri e contesto.' },
  { value: 'bars', label: 'Barre', description: 'Confronta i valori sulla stessa scala.' },
  { value: 'scatter', label: 'Mappa', description: 'Confronta quantità e risultato con una mappa a punti.' },
  { value: 'radar', label: 'Radar', description: 'Confronta i profili di comportamento; altrove usa le barre.' },
]

interface DataViewSnapshot {
  readonly view: DataViewPreference
  readonly storageAvailable: boolean
}

const initialSnapshot: DataViewSnapshot = { view: 'list', storageAvailable: true }
const fallbacks: Record<DataViewPreference, readonly DataViewPreference[]> = {
  list: ['list'],
  cards: ['cards', 'list'],
  bars: ['bars', 'cards', 'list'],
  scatter: ['scatter', 'bars', 'cards', 'list'],
  radar: ['radar', 'bars', 'cards', 'list'],
}

function isDataView(value: unknown): value is DataViewPreference {
  return typeof value === 'string' && Object.hasOwn(fallbacks, value)
}

export function parseDataView(value: string | null): DataViewPreference {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null')
    if (parsed && typeof parsed === 'object' && 'view' in parsed && isDataView(parsed.view)) return parsed.view
  } catch { /* An incompatible preference must not prevent the app from opening. */ }
  return initialSnapshot.view
}

/** A section resolves its supported representation without changing the global choice. */
export function resolveDataView<View extends DataViewPreference>(
  preference: DataViewPreference, supported: readonly View[], fallback: View = 'list' as View,
): View {
  for (const candidate of fallbacks[preference]) {
    const match = supported.find((view) => view === candidate)
    if (match) return match
  }
  return supported.includes(fallback) ? fallback : supported[0] ?? fallback
}

/** One cached preference, one storage listener, and no storage reads during navigation. */
export function createDataViewStore() {
  let snapshot = initialSnapshot
  let initialized = false
  let storage: Storage | undefined
  const listeners = new Set<() => void>()

  function publish(view: DataViewPreference, storageAvailable: boolean) {
    if (snapshot.view === view && snapshot.storageAvailable === storageAvailable) return
    snapshot = { view, storageAvailable }
    listeners.forEach((listener) => listener())
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== DATA_VIEW_STORAGE_KEY && event.key !== null) return
    if (event.storageArea && event.storageArea !== storage) return
    publish(parseDataView(event.newValue), snapshot.storageAvailable)
  }

  function initialize() {
    if (initialized || typeof window === 'undefined') return
    initialized = true
    window.addEventListener('storage', onStorage)
    try {
      storage = window.localStorage
      publish(parseDataView(storage.getItem(DATA_VIEW_STORAGE_KEY)), true)
    } catch { publish(initialSnapshot.view, false) }
  }

  function setView(view: DataViewPreference) {
    initialize()
    if (!isDataView(view) || view === snapshot.view) return
    let storageAvailable = true
    try {
      // A blocked browser can still keep the choice for this app session.
      storage ??= window.localStorage
      storage.setItem(DATA_VIEW_STORAGE_KEY, JSON.stringify({ view }))
    } catch { storageAvailable = false }
    publish(view, storageAvailable)
  }

  return {
    initialize, setView,
    getSnapshot: () => snapshot,
    getView: () => snapshot.view,
    subscribe(listener: () => void) {
      initialize()
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
      listeners.clear()
      storage = undefined
      initialized = false
      snapshot = initialSnapshot
    },
  }
}

export const dataViewStore = createDataViewStore()

/** Restore before React's first render so pages mount directly in the chosen view. */
export const initializeDataView = dataViewStore.initialize

export function useDataView() {
  return useSyncExternalStore(dataViewStore.subscribe, dataViewStore.getView, () => initialSnapshot.view)
}

export function useDataViewSettings() {
  const snapshot = useSyncExternalStore(dataViewStore.subscribe, dataViewStore.getSnapshot, () => initialSnapshot)
  return { ...snapshot, setView: dataViewStore.setView }
}
