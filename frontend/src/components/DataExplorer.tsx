import { useId, useMemo, useState, type ReactNode } from 'react'
import { resolveDataView, useDataView } from '../app/data-view'
import { credibleMassLabel, useAlgorithmSettings } from '../app/algorithm-settings'
import { ChampionAvatar } from './ui'
import '../data-explorer.css'

export type DataViewMode = 'list' | 'cards' | 'bars' | 'scatter'

export interface DataVisualItem {
  id: string
  label: string
  subtitle?: string
  image?: string
  value: number | null | undefined
  valueLabel?: string
  sample?: number | null
  sampleLabel?: string
  low?: number | null
  high?: number | null
  intervalLabel?: string
  reference?: number | null
  tone?: 'positive' | 'warning' | 'negative' | 'info' | 'neutral'
  details?: ReactNode
  action?: ReactNode
}

interface DataExplorerProps {
  id: string
  label: string
  items: DataVisualItem[]
  children: ReactNode
  metricLabel: string
  valueDomain?: readonly [number, number]
  valueSuffix?: string
  sampleLabel?: string
  defaultView?: DataViewMode
  views?: DataViewMode[]
  listLabel?: string
}

const allViews: DataViewMode[] = ['list', 'cards', 'bars', 'scatter']
const names = { list: 'Elenco', cards: 'Schede', bars: 'Barre', scatter: 'Mappa' }
const emptyItems: DataVisualItem[] = []
const emptyDomain = [0, 1] as const
const number = (value: number) => value.toLocaleString('it-IT', { maximumFractionDigits: 1 })
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const within = (value: number, domain: readonly [number, number]) => Math.max(0, Math.min(100, (value - domain[0]) / (domain[1] - domain[0]) * 100))

function roundedDomain(min: number, max: number): readonly [number, number] {
  if (min === max) return [0, 1]
  const bound = Math.max(Math.abs(min), Math.abs(max))
  const step = 10 ** Math.floor(Math.log10(bound))
  // Mixed signs share a symmetric axis, so equivalent changes have equivalent lengths.
  if (min < 0 && max > 0) return [-Math.ceil(bound / step) * step, Math.ceil(bound / step) * step]
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step]
}

/** Keep missing observations missing; an empty or all-zero series still has a valid axis. */
export function dataDomain(items: readonly DataVisualItem[], fixed?: readonly [number, number]): readonly [number, number] {
  if (fixed && finite(fixed[0]) && finite(fixed[1]) && fixed[1] > fixed[0]) return fixed
  let min = 0, max = 0
  for (const item of items) {
    if (!finite(item.value)) continue
    const values = [item.value, item.reference]
    if (finite(item.low) && finite(item.high) && item.low <= item.high) values.push(item.low, item.high)
    for (const value of values) {
      if (finite(value)) { min = Math.min(min, value); max = Math.max(max, value) }
    }
  }
  return roundedDomain(min, max)
}

function ItemCard({ item, metricLabel, valueSuffix = '', sampleLabel = 'partite' }: {
  item: DataVisualItem; metricLabel: string; valueSuffix?: string; sampleLabel?: string
}) {
  const { credibleMass } = useAlgorithmSettings()
  return <article className="data-explorer__card" data-tone={item.tone ?? 'info'}>
    <header>
      {item.image ? <ChampionAvatar name={item.label} src={item.image} /> : null}
      <div><h3>{item.label}</h3>{item.subtitle ? <p>{item.subtitle}</p> : null}</div>
    </header>
    <div className="data-explorer__card-value"><strong>{finite(item.value) ? item.valueLabel ?? `${number(item.value)}${valueSuffix}` : 'Non disponibile'}</strong><span>{metricLabel}</span></div>
    <dl className="data-explorer__facts">
      {finite(item.sample) ? <div><dt>{item.sampleLabel ?? sampleLabel}</dt><dd>{number(item.sample)}</dd></div> : null}
      {finite(item.low) && finite(item.high) && item.low <= item.high ? <div><dt>{item.intervalLabel ?? `Intervallo ${credibleMassLabel(credibleMass)}`}</dt><dd>{number(item.low)}–{number(item.high)}{valueSuffix}</dd></div> : null}
      {finite(item.reference) ? <div><dt>Riferimento</dt><dd>{number(item.reference)}{valueSuffix}</dd></div> : null}
    </dl>
    {item.details ? <div className="data-explorer__details">{item.details}</div> : null}
    {item.action ? <div className="data-explorer__actions">{item.action}</div> : null}
  </article>
}

/** Only the inspected item is reset when a caller changes datasets. */
export function DataExplorer(props: DataExplorerProps) {
  return <Explorer key={props.id} {...props} />
}

function Explorer({ id, label, items, children, metricLabel, valueDomain, valueSuffix = '', sampleLabel = 'partite', defaultView = 'list', views = allViews, listLabel = 'Elenco' }: DataExplorerProps) {
  const { credibleMass } = useAlgorithmSettings()
  const contentId = useId()
  const inspectionId = `${contentId}-inspection`
  const preferredView = useDataView()
  const [selectedId, setSelectedId] = useState('')
  const activeView = resolveDataView(preferredView, views, defaultView)
  const chart = useMemo(() => {
    if (activeView !== 'bars' && activeView !== 'scatter') return undefined
    const plotItems: DataVisualItem[] = []
    const intervalLabels = new Set<string>()
    let hasInterval = false, hasReference = false, maxSample = 0
    for (const item of items) {
      if (!finite(item.value)) continue
      if (activeView === 'bars') {
        hasInterval ||= finite(item.low) && finite(item.high) && item.low <= item.high
        if (finite(item.low) && finite(item.high) && item.low <= item.high) {
          intervalLabels.add(item.intervalLabel ?? `Intervallo ${credibleMassLabel(credibleMass)}`)
        }
        hasReference ||= finite(item.reference)
      } else if (finite(item.sample) && item.sample >= 0) {
        plotItems.push(item)
        maxSample = Math.max(maxSample, item.sample)
      }
    }
    return { domain: dataDomain(items, valueDomain), plotItems, sampleDomain: roundedDomain(0, maxSample), hasInterval, hasReference, intervalLabels: [...intervalLabels] }
  }, [items, valueDomain, activeView, credibleMass])
  const { domain = emptyDomain, plotItems = emptyItems, sampleDomain = emptyDomain, hasInterval = false, hasReference = false, intervalLabels = [] } = chart ?? {}
  const currentItems = activeView === 'scatter' ? plotItems : items
  const selected = chart ? currentItems.find((item) => item.id === selectedId) ?? currentItems[0] : undefined
  const displayValue = (item: DataVisualItem) => finite(item.value) ? item.valueLabel ?? `${number(item.value)}${valueSuffix}` : 'Non disponibile'
  const describe = (item: DataVisualItem) => `${item.label}${item.subtitle ? ` · ${item.subtitle}` : ''}: ${displayValue(item)}${finite(item.sample) ? ` · ${number(item.sample)} ${item.sampleLabel ?? sampleLabel}` : ''}`
  return <section className="data-explorer" aria-label={`Visualizzazioni: ${label}`} data-view={activeView} data-explorer-id={id}>
    <div className="data-explorer__heading">
      <strong>{label}</strong><span className="data-explorer__count">{items.length} {items.length === 1 ? 'elemento' : 'elementi'}</span>
      {activeView !== preferredView ? <span className="data-explorer__fallback">Vista {names[activeView]} per questi dati</span> : null}
    </div>
    <div className="data-explorer__guide">
      <p>{activeView === 'list' ? 'Tutti i dettagli nella vista originale.' : activeView === 'cards' ? 'Una scheda per elemento, con numeri e contesto insieme.' : activeView === 'bars' ? 'Confronta i valori sulla stessa scala. Seleziona una barra per i dettagli.' : 'Confronta quantità e risultato. Seleziona un punto o un nome per i dettagli.'}</p>
    </div>
    <div id={contentId}>
      {activeView === 'list' ? children : !items.length ? <p className="data-explorer__empty">Nessun dato da rappresentare con i filtri attuali.</p> : activeView === 'cards' ? (
        <div className="data-explorer__cards">{items.map((item) => <ItemCard key={item.id} item={item} metricLabel={metricLabel} valueSuffix={valueSuffix} sampleLabel={sampleLabel} />)}</div>
      ) : <>
        <div className="data-explorer__chart-title"><strong>{metricLabel}</strong><span>{activeView === 'scatter' ? `in relazione a ${sampleLabel}` : `${number(domain[0])}–${number(domain[1])}${valueSuffix}`}</span></div>
        {activeView === 'bars' ? <>
          <div className="data-explorer__bars" role="group" aria-label={`Barre: ${label}`}>
            {items.map((item) => {
              const position = finite(item.value) ? within(item.value, domain) : 0
              const origin = within(0, domain)
              const interval = finite(item.low) && finite(item.high) && item.low <= item.high
              return <button key={item.id} type="button" className="data-explorer__bar" data-tone={item.tone ?? 'info'} aria-label={describe(item)} aria-pressed={selected?.id === item.id} aria-controls={inspectionId} onClick={() => setSelectedId(item.id)}>
                <span className="data-explorer__bar-heading"><span>{item.label}{item.subtitle ? <small>{item.subtitle}</small> : null}</span><strong>{displayValue(item)}</strong></span>
                {finite(item.value) ? <span className="data-explorer__rail" aria-hidden="true">
                  <span className="data-explorer__zero" style={{ left: `${origin}%` }} />
                  <span className="data-explorer__fill" style={{ left: `${Math.min(origin, position)}%`, width: `${Math.abs(position - origin)}%` }} />
                  {interval ? <span className="data-explorer__interval" style={{ left: `${within(item.low!, domain)}%`, width: `${within(item.high!, domain) - within(item.low!, domain)}%` }} /> : null}
                  <span className="data-explorer__marker" style={{ left: `${position}%` }} />
                  {finite(item.reference) ? <span className="data-explorer__reference" style={{ left: `${within(item.reference, domain)}%` }} /> : null}
                </span> : null}
              </button>
            })}
          </div>
          {hasInterval || hasReference ? <p className="data-explorer__legend">{hasInterval ? <span><i className="data-explorer__legend-interval" aria-hidden="true" />Tratto sottile: {intervalLabels.join(' · ')}</span> : null}{hasReference ? <span><i className="data-explorer__legend-reference" aria-hidden="true" />Tratteggio: riferimento</span> : null}</p> : null}
        </> : plotItems.length ? <>
          <figure className="data-explorer__scatter">
            <div className="data-explorer__y-title">{metricLabel}{valueSuffix ? ` (${valueSuffix.trim()})` : ''}</div>
            <div className="data-explorer__plot">
              {[0, 25, 50, 75, 100].map((position) => <div key={position} className="data-explorer__gridline" style={{ bottom: `${position}%` }} aria-hidden="true"><span>{number(domain[0] + (domain[1] - domain[0]) * position / 100)}</span></div>)}
              {plotItems.map((item, index) => <button key={item.id} type="button" className="data-explorer__point" data-tone={item.tone ?? 'info'} aria-label={describe(item)} title={describe(item)} aria-pressed={selected?.id === item.id} aria-controls={inspectionId} onClick={() => setSelectedId(item.id)} style={{ left: `${within(item.sample!, sampleDomain)}%`, bottom: `${within(item.value!, domain)}%` }}><span>{index + 1}</span></button>)}
              <div className="data-explorer__x-ticks" aria-hidden="true">{[0, 25, 50, 75, 100].map((position) => <span key={position} style={{ left: `${position}%` }}>{number(sampleDomain[0] + (sampleDomain[1] - sampleDomain[0]) * position / 100)}</span>)}</div>
            </div>
            <figcaption>{sampleLabel} →<span>Ogni punto è un elemento. I punti sovrapposti si possono scegliere dal menu sotto.</span></figcaption>
          </figure>
          {plotItems.length !== items.length ? <p className="data-explorer__note">{items.length - plotItems.length} {items.length - plotItems.length === 1 ? 'elemento senza entrambe le misure: disponibile' : 'elementi senza entrambe le misure: disponibili'} nella vista Schede o {listLabel}.</p> : null}
        </> : <p className="data-explorer__empty">La mappa richiede un valore e una quantità disponibili per lo stesso elemento. Le altre viste conservano tutti i dati.</p>}
        {selected ? <div className="data-explorer__inspection" id={inspectionId} role="region" aria-label={`Dettagli selezionati: ${selected.label}`} aria-live="polite">
          <label>Esamina un elemento<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{currentItems.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.label}{item.subtitle ? ` · ${item.subtitle}` : ''}</option>)}</select></label>
          <ItemCard item={selected} metricLabel={metricLabel} valueSuffix={valueSuffix} sampleLabel={sampleLabel} />
        </div> : null}
      </>}
    </div>
  </section>
}
