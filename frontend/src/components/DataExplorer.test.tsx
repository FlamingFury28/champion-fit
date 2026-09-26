import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_VIEW_STORAGE_KEY, dataViewStore } from '../app/data-view'
import { DataExplorer, dataDomain, type DataVisualItem } from './DataExplorer'

const items: DataVisualItem[] = [
  { id: 'ahri-mid', label: 'Ahri', subtitle: 'Centrale', value: 60, valueLabel: '60%', sample: 25, low: 45, high: 75, reference: 50, details: 'Segnale da verificare', action: <a href="/app/champions/Ahri">Vedi i dati</a> },
  { id: 'lux-support', label: 'Lux', subtitle: 'Supporto', value: 52, sample: 8, details: 'Solo otto partite' },
  { id: 'unknown', label: 'Senza stima', value: null, sample: 0 },
]
const explorer = (rows = items, id = 'test') => <DataExplorer id={id} label="Campioni" items={rows} metricLabel="Vittorie stimate" valueDomain={[0, 100]} valueSuffix="%" listLabel="Tabella"><p>Tabella originale</p></DataExplorer>

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  dataViewStore.dispose()
  dataViewStore.initialize()
})

afterEach(() => dataViewStore.dispose())

describe('viste alternative dello stesso insieme di dati', () => {
  it('usa la scelta globale al remount e mantiene azioni e contesto nelle schede', () => {
    const view = render(explorer())
    act(() => dataViewStore.setView('cards'))
    expect(screen.getByRole('link', { name: 'Vedi i dati' })).toHaveAttribute('href', '/app/champions/Ahri')
    expect(screen.getByText('Segnale da verificare')).toBeVisible()
    expect(screen.getByText('45–75%')).toBeVisible()
    expect(screen.queryByText('Tabella originale')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /Rappresentazione:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Torna a/i })).not.toBeInTheDocument()
    view.unmount()
    render(explorer())
    expect(screen.getByRole('link', { name: 'Vedi i dati' })).toBeVisible()
    expect(dataViewStore.getSnapshot().view).toBe('cards')
  })

  it('esclude le misure mancanti dalla mappa senza trasformarle in zero e aggiorna i dettagli al cambio filtro', async () => {
    const view = render(explorer())
    act(() => dataViewStore.setView('scatter'))
    expect(screen.queryByRole('button', { name: /Senza stima:/ })).not.toBeInTheDocument()
    expect(screen.getByText(/1 elemento senza entrambe le misure/)).toBeVisible()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Esamina un elemento' }), 'lux-support')
    expect(screen.getByText('Solo otto partite')).toBeVisible()
    view.rerender(explorer([items[0]!]))
    expect(screen.queryByText('Solo otto partite')).not.toBeInTheDocument()
    expect(screen.getByText('Segnale da verificare')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Esamina un elemento' })).toHaveValue('ahri-mid')
  })

  it('tollera preferenze corrotte o storage non disponibile e applica la scelta a ogni dataset', () => {
    dataViewStore.dispose()
    localStorage.setItem(DATA_VIEW_STORAGE_KEY, '{preferenza corrotta')
    dataViewStore.initialize()
    const view = render(explorer())
    expect(screen.getByText('Tabella originale')).toBeVisible()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    act(() => dataViewStore.setView('cards'))
    expect(screen.getByText('Segnale da verificare')).toBeVisible()
    view.rerender(explorer(items, 'separate'))
    expect(screen.getByText('Segnale da verificare')).toBeVisible()
    expect(dataViewStore.getSnapshot()).toMatchObject({ view: 'cards', storageAvailable: false })
  })

  it('una preferenza non supportata usa il fallback senza riscrivere la scelta globale', () => {
    act(() => dataViewStore.setView('scatter'))
    render(<DataExplorer id="screen" label="Ipotesi" items={items} metricLabel="Indice teorico" views={['list', 'cards', 'bars']}><p>Ipotesi originali</p></DataExplorer>)
    expect(screen.getByRole('group', { name: 'Barre: Ipotesi' })).toBeVisible()
    expect(screen.getByLabelText('Visualizzazioni: Ipotesi')).toHaveAttribute('data-view', 'bars')
    expect(dataViewStore.getSnapshot().view).toBe('scatter')
  })

  it('le barre divergenti partono da zero e restano selezionabili da tastiera', async () => {
    act(() => dataViewStore.setView('bars'))
    render(<DataExplorer id="lift" label="Confronti" items={[{ id: 'negative', label: 'Svantaggio', value: -10, reference: 0 }, { id: 'positive', label: 'Vantaggio', value: 20, reference: 0 }]} metricLabel="Differenza" valueSuffix=" pp"><p>Elenco</p></DataExplorer>)
    const bars = screen.getByRole('group', { name: 'Barre: Confronti' })
    const negative = within(bars).getByRole('button', { name: 'Svantaggio: -10 pp' })
    expect(negative.querySelector('.data-explorer__fill')).toHaveStyle({ left: '25%', width: '25%' })
    const positive = within(bars).getByRole('button', { name: 'Vantaggio: 20 pp' })
    expect(positive).toHaveAttribute('aria-controls')
    expect(positive.querySelector('.data-explorer__fill')).toHaveStyle({ left: '50%', width: '50%' })
    positive.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Vantaggio' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Dettagli selezionati: Vantaggio' })).toBeVisible()
  })

  it('calcola scale finite anche con null, NaN, serie vuote e intervalli', () => {
    expect(dataDomain([])).toEqual([0, 1])
    expect(dataDomain([{ id: 'a', label: '', value: null, high: 100 }])).toEqual([0, 1])
    expect(dataDomain([{ id: 'a', label: '', value: -12 }, { id: 'b', label: '', value: 7 }])).toEqual([-20, 20])
    expect(dataDomain([{ id: 'a', label: '', value: 55, low: 30, high: 88 }])).toEqual([0, 90])
    expect(dataDomain([{ id: 'a', label: '', value: NaN }], [0, 0])).toEqual([0, 1])
  })
})
