import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY, createAppearanceStore, DEFAULT_APPEARANCE, parseAppearance } from './appearance'

function mockSystemTheme(initialDark: boolean) {
  const listeners = new Set<() => void>()
  const media = {
    matches: initialDark,
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  return {
    media,
    change(dark: boolean) { media.matches = dark; listeners.forEach((listener) => listener()) },
  }
}

describe('preferenze aspetto persistenti', () => {
  const stores: ReturnType<typeof createAppearanceStore>[] = []
  function store() { const result = createAppearanceStore(); stores.push(result); return result }
  beforeEach(() => { localStorage.clear(); mockSystemTheme(false) })
  afterEach(() => {
    stores.splice(0).forEach((current) => current.dispose())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.accent
    delete document.documentElement.dataset.density
    document.documentElement.style.removeProperty('color-scheme')
  })

  it('mantiene il tema scuro iniziale anche se il sistema è chiaro', () => {
    const current = store()
    current.initialize()
    expect(current.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  })

  it('ripristina tema, accento e densità da una nuova sessione', () => {
    const first = store()
    first.updatePreferences({ theme: 'light', accent: 'sky', density: 'compact' })
    first.dispose()
    const restored = store()
    restored.initialize()
    expect(restored.getSnapshot()).toEqual({
      preferences: { theme: 'light', accent: 'sky', density: 'compact' },
      resolvedTheme: 'light', storageAvailable: true,
    })
    expect(document.documentElement).toHaveAttribute('data-accent', 'sky')
    expect(document.documentElement).toHaveAttribute('data-density', 'compact')
  })

  it('segue i cambiamenti live del sistema solo quando selezionato', () => {
    const system = mockSystemTheme(false)
    const current = store()
    const listener = vi.fn()
    current.subscribe(listener)
    current.updatePreferences({ theme: 'system' })
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    system.change(true)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(current.getSnapshot().preferences.theme).toBe('system')
    current.updatePreferences({ theme: 'light' })
    listener.mockClear()
    system.change(false)
    system.change(true)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(listener).not.toHaveBeenCalled()
  })

  it.each(['broken {', '[]', 'null', '42', '"dark"'])('recupera dati incompatibili %s senza bloccare il caricamento', (value) => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, value)
    const current = store()
    expect(() => current.initialize()).not.toThrow()
    expect(current.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE)
  })

  it('recupera i singoli campi validi e ignora proprietà sconosciute', () => {
    expect(parseAppearance(JSON.stringify({ theme: 'neon', accent: 'amber', density: false, other: 'value' })))
      .toEqual({ theme: 'dark', accent: 'amber', density: 'comfortable' })
  })

  it('continua a funzionare in memoria quando lo storage è bloccato', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    }
    const current = store()
    expect(() => current.initialize()).not.toThrow()
    expect(current.getSnapshot().storageAvailable).toBe(false)
    current.updatePreferences({ theme: 'light', accent: 'amber' })
    expect(current.getSnapshot().preferences).toEqual({ theme: 'light', accent: 'amber', density: 'comfortable' })
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(() => current.resetPreferences()).not.toThrow()
    expect(current.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE)
  })

  it('ripristina i valori iniziali e rimuove soltanto la propria chiave', () => {
    localStorage.setItem('profile_accounts', '["Alpha#EUW"]')
    const current = store()
    current.updatePreferences({ theme: 'system', accent: 'amber', density: 'compact' })
    current.resetPreferences()
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('profile_accounts')).toBe('["Alpha#EUW"]')
    expect(current.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('sincronizza le preferenze e il ripristino da un’altra scheda', () => {
    const current = store()
    current.initialize()
    window.dispatchEvent(new StorageEvent('storage', {
      key: APPEARANCE_STORAGE_KEY,
      newValue: JSON.stringify({ theme: 'light', accent: 'sky', density: 'compact' }),
    }))
    expect(current.getSnapshot().preferences.accent).toBe('sky')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY, newValue: null }))
    expect(current.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE)
  })

  it('installa una sola sottoscrizione anche con inizializzazione ripetuta', () => {
    const { media } = mockSystemTheme(true)
    const current = store()
    current.initialize()
    current.initialize()
    const unsubscribe = current.subscribe(vi.fn())
    expect(media.addEventListener).toHaveBeenCalledTimes(1)
    unsubscribe()
    current.dispose()
    expect(media.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('usa il tema scuro di base se il browser non espone la preferenza di sistema', () => {
    vi.stubGlobal('matchMedia', undefined)
    const current = store()
    expect(() => current.updatePreferences({ theme: 'system' })).not.toThrow()
    expect(current.getSnapshot().preferences.theme).toBe('system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })
})
