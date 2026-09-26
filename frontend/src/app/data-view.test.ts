import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataViewStore, DATA_VIEW_STORAGE_KEY, parseDataView, resolveDataView, type DataViewPreference } from './data-view'

describe('preferenza globale delle rappresentazioni', () => {
  const stores: ReturnType<typeof createDataViewStore>[] = []
  function store() {
    const current = createDataViewStore()
    stores.push(current)
    return current
  }

  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
  afterEach(() => {
    stores.splice(0).forEach((current) => current.dispose())
    vi.restoreAllMocks()
  })

  it('legge una sola chiave una sola volta anche con più pagine, sezioni e inizializzazioni', () => {
    localStorage.setItem(DATA_VIEW_STORAGE_KEY, JSON.stringify({ view: 'cards' }))
    localStorage.setItem('champion-fit:data-view:fit-matrix:v1', 'bars')
    const read = vi.spyOn(Storage.prototype, 'getItem')
    const listen = vi.spyOn(window, 'addEventListener')
    const current = store()
    current.initialize()
    current.initialize()
    expect(current.getSnapshot().view).toBe('cards')
    const firstPage = current.subscribe(vi.fn())
    const secondSection = current.subscribe(vi.fn())
    firstPage()
    secondSection()
    current.subscribe(vi.fn())
    current.getSnapshot()
    expect(read.mock.calls).toEqual([[DATA_VIEW_STORAGE_KEY]])
    expect(listen.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1)
  })

  it('salva la scelta globale e la ripristina prima di montare una nuova pagina', () => {
    const current = store()
    current.setView('scatter')
    expect(JSON.parse(localStorage.getItem(DATA_VIEW_STORAGE_KEY)!)).toEqual({ view: 'scatter' })
    current.dispose()
    const restored = store()
    restored.initialize()
    expect(restored.getSnapshot()).toEqual({ view: 'scatter', storageAvailable: true })
  })

  it('non riscrive, non notifica e mantiene lo snapshot se la scelta non cambia', () => {
    const current = store()
    current.setView('bars')
    const listener = vi.fn()
    current.subscribe(listener)
    const snapshot = current.getSnapshot()
    const write = vi.spyOn(Storage.prototype, 'setItem')
    current.setView('bars')
    current.initialize()
    expect(write).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(current.getSnapshot()).toBe(snapshot)
    current.setView('cards')
    expect(write).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each(['broken {', '[]', 'null', '42', '"bars"', '{"view":"unknown"}'])('recupera una preferenza incompatibile %s', (value) => {
    localStorage.setItem(DATA_VIEW_STORAGE_KEY, value)
    const current = store()
    expect(() => current.initialize()).not.toThrow()
    expect(current.getSnapshot().view).toBe('list')
  })

  it('ignora campi sconosciuti e non importa le vecchie scelte per sezione', () => {
    expect(parseDataView('{"view":"radar","other":true}')).toBe('radar')
    localStorage.setItem('champion-fit:data-view:fit-matrix:v1', 'bars')
    localStorage.setItem('champion-fit:data-view:playstyle-behavior:v1', 'radar')
    const current = store()
    current.initialize()
    expect(current.getView()).toBe('list')
  })

  it('propaga la scelta in memoria anche con lettura e salvataggio bloccati', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    const current = store()
    const listener = vi.fn()
    current.initialize()
    current.subscribe(listener)
    expect(current.getSnapshot()).toEqual({ view: 'list', storageAvailable: false })
    expect(() => current.setView('cards')).not.toThrow()
    expect(current.getSnapshot()).toEqual({ view: 'cards', storageAvailable: false })
    current.subscribe(vi.fn())
    expect(read).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('recupera il salvataggio alla scelta successiva quando il browser torna disponibile', () => {
    const current = store()
    current.initialize()
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError') })
    current.setView('radar')
    expect(current.getSnapshot()).toEqual({ view: 'radar', storageAvailable: false })
    current.setView('scatter')
    expect(write).toHaveBeenCalledTimes(2)
    expect(current.getSnapshot()).toEqual({ view: 'scatter', storageAvailable: true })
    expect(parseDataView(localStorage.getItem(DATA_VIEW_STORAGE_KEY))).toBe('scatter')
  })

  it('sincronizza altre schede dal payload senza riletture né scritture di ritorno', () => {
    const current = store()
    current.initialize()
    const listener = vi.fn()
    current.subscribe(listener)
    const read = vi.spyOn(Storage.prototype, 'getItem')
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const event = new StorageEvent('storage', {
      key: DATA_VIEW_STORAGE_KEY, newValue: '{"view":"radar"}', storageArea: localStorage,
    })
    window.dispatchEvent(event)
    expect(current.getView()).toBe('radar')
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(event)
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent('storage', { key: DATA_VIEW_STORAGE_KEY, newValue: null, storageArea: localStorage }))
    expect(current.getView()).toBe('list')
    window.dispatchEvent(event)
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage }))
    expect(current.getView()).toBe('list')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('ignora eventi di altre preferenze o dello storage della sessione', () => {
    const current = store()
    current.setView('cards')
    const snapshot = current.getSnapshot()
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: '{"view":"bars"}' }))
    window.dispatchEvent(new StorageEvent('storage', { key: DATA_VIEW_STORAGE_KEY, newValue: '{"view":"bars"}', storageArea: sessionStorage }))
    expect(current.getSnapshot()).toBe(snapshot)
  })

  it('rimuove la sottoscrizione globale quando viene dismesso', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const current = store()
    current.initialize()
    const listener = vi.fn()
    current.subscribe(listener)
    current.dispose()
    window.dispatchEvent(new StorageEvent('storage', { key: DATA_VIEW_STORAGE_KEY, newValue: '{"view":"radar"}' }))
    expect(current.getView()).toBe('list')
    expect(listener).not.toHaveBeenCalled()
    expect(remove.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1)
  })
})

describe('rappresentazione compatibile senza alterare la preferenza', () => {
  it.each<DataViewPreference>(['list', 'cards', 'bars', 'scatter', 'radar'])('mantiene %s quando supportata', (view) => {
    expect(resolveDataView(view, ['list', 'cards', 'bars', 'scatter', 'radar'])).toBe(view)
  })

  it.each([
    ['scatter', ['list', 'cards', 'bars'], 'bars'],
    ['radar', ['list', 'cards', 'bars'], 'bars'],
    ['bars', ['list', 'cards'], 'cards'],
    ['scatter', ['list', 'cards'], 'cards'],
    ['radar', ['list'], 'list'],
    ['cards', ['list'], 'list'],
  ] as const)('adatta %s alle viste disponibili %j', (view, supported, expected) => {
    expect(resolveDataView(view, supported)).toBe(expected)
  })

  it('rispetta il fallback esplicito quando non esiste un’alternativa compatibile', () => {
    expect(resolveDataView('list', ['bars', 'scatter'], 'scatter')).toBe('scatter')
    expect(resolveDataView('list', [], 'cards')).toBe('cards')
  })
})
