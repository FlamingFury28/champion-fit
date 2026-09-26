import { useId, useMemo, type ReactNode } from 'react'
import type { PlaystyleBehavior, PlaystyleDistribution } from '../api/playstyles'
import { useDataView } from '../app/data-view'
import { DataTable } from './ui'
import './BehaviorRadar.css'

type RadarAxis = PlaystyleBehavior & {
  percentiles: PlaystyleBehavior['percentiles'] & { wins: PlaystyleDistribution; losses: PlaystyleDistribution }
}

const format = (value: number) => value.toLocaleString('it-IT', { maximumFractionDigits: 1 })
const validDistribution = (value: PlaystyleDistribution | null): value is PlaystyleDistribution =>
  value != null && Number.isFinite(value.median) && value.median >= 0 && value.median <= 100 && Number.isFinite(value.n) && value.n > 0
const hasCommonPercentiles = (item: PlaystyleBehavior): item is RadarAxis =>
  item.percentiles.accounts > 0 && validDistribution(item.percentiles.wins) && validDistribution(item.percentiles.losses)

const center = { x: 260, y: 195 }
const radius = 125
function point(index: number, count: number, value: number, offset = 0) {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / count
  const distance = radius * value / 100 + offset
  return { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance }
}
const coordinates = (value: { x: number; y: number }) => `${value.x},${value.y}`

export function BehaviorRadar({ items, children }: { items: PlaystyleBehavior[]; children: ReactNode }) {
  const preferredView = useDataView()
  const contentId = useId()
  const titleId = useId()
  const descriptionId = useId()
  const { axes, excluded } = useMemo(() => {
    const axes: RadarAxis[] = [], excluded: PlaystyleBehavior[] = []
    if (preferredView === 'radar') {
      for (const item of items) {
        if (hasCommonPercentiles(item)) axes.push(item)
        else excluded.push(item)
      }
    }
    return { axes, excluded }
  }, [items, preferredView])
  const canPlot = axes.length >= 3
  const view = preferredView === 'radar' && canPlot ? 'radar' : 'details'
  return <div className="behavior-views">
    {preferredView === 'radar' && !canPlot ? <p className="playstyles-method">Il radar richiede almeno 3 metriche con percentili disponibili sia nelle vittorie sia nelle sconfitte: {axes.length} di {items.length} in questo contesto. I dettagli mostrano tutti i valori disponibili.</p> : null}
    <div id={contentId} data-view={view}>
      {view === 'details' ? children : <>
        <figure className="behavior-radar">
          <figcaption>
            <h3>Vittorie e sconfitte nel tuo contesto</h3>
            <p>Mediane su una scala comune da 0 a 100 · {axes.length} metriche confrontabili. Un percentile alto indica una posizione relativa più alta, non un risultato migliore.</p>
          </figcaption>
          <div className="behavior-radar__legend" aria-label="Legenda del radar">
            <span><i className="behavior-radar__key" data-outcome="wins" aria-hidden="true" />Nelle vittorie · linea continua</span>
            <span><i className="behavior-radar__key" data-outcome="losses" aria-hidden="true" />Nelle sconfitte · linea tratteggiata</span>
          </div>
          <svg className="behavior-radar__chart" viewBox="0 0 520 400" role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
            <title id={titleId}>Confronto delle mediane dei percentili nelle vittorie e nelle sconfitte</title>
            <desc id={descriptionId}>Scala da 0 al centro a 100 sul bordo. Assi: {axes.map((item) => item.label).join(', ')}. Valori e campioni sono riportati nella tabella seguente.</desc>
            {[25, 50, 75, 100].map((level) => <polygon key={level} className="behavior-radar__grid" points={axes.map((_, index) => coordinates(point(index, axes.length, level))).join(' ')} />)}
            {axes.map((item, index) => {
              const edge = point(index, axes.length, 100)
              const label = point(index, axes.length, 100, 24)
              const anchor = label.x > center.x + 5 ? 'start' : label.x < center.x - 5 ? 'end' : 'middle'
              return <g key={item.id}>
                <line className="behavior-radar__axis" x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} />
                <text className="behavior-radar__label" x={label.x} y={label.y} textAnchor={anchor} dominantBaseline="middle">{item.label}</text>
              </g>
            })}
            {[0, 25, 50, 75, 100].map((level) => <text key={level} className="behavior-radar__tick" x={center.x + 7} y={center.y - radius * level / 100 + 4}>{level}</text>)}
            {(['wins', 'losses'] as const).map((outcome) => <g key={outcome} className="behavior-radar__series" data-outcome={outcome}>
              <polygon points={axes.map((item, index) => coordinates(point(index, axes.length, item.percentiles[outcome].median))).join(' ')} />
              {axes.map((item, index) => {
                const position = point(index, axes.length, item.percentiles[outcome].median)
                return outcome === 'wins'
                  ? <circle key={item.id} cx={position.x} cy={position.y} r="4" />
                  : <rect key={item.id} x={position.x - 3.5} y={position.y - 3.5} width="7" height="7" />
              })}
            </g>)}
          </svg>
        </figure>
        {excluded.length ? <p className="playstyles-method">Esclusi dal radar: {excluded.map((item) => item.label).join(', ')}. Mancano percentili validi con osservazioni in entrambi gli esiti; nessun valore è sostituito.</p> : null}
        <DataTable label="Valori e copertura del radar dei comportamenti">
          <thead><tr><th>Metrica</th><th>Nelle vittorie · mediana</th><th>Nelle sconfitte · mediana</th><th>Copertura del confronto</th></tr></thead>
          <tbody>{axes.map((item) => <tr key={item.id}>
            <th scope="row">{item.label}</th>
            <td>{format(item.percentiles.wins.median)} / 100<small className="playstyles-cell-detail">{item.percentiles.wins.n} partite</small></td>
            <td>{format(item.percentiles.losses.median)} / 100<small className="playstyles-cell-detail">{item.percentiles.losses.n} partite</small></td>
            <td>{item.percentiles.accounts} account confrontabili{item.percentiles.excluded_accounts.length ? <small className="playstyles-cell-detail">Esclusi: {item.percentiles.excluded_accounts.join(', ')}</small> : null}</td>
          </tr>)}</tbody>
        </DataTable>
        <p className="playstyles-method">I campioni possono variare fra metriche. La forma del radar non è un punteggio di abilità; scegli Elenco in Vista dati per leggere anche i valori osservati e gli intervalli centrali.</p>
      </>}
    </div>
  </div>
}
