import type { MatchupItemDto } from '../api/types'
import { pct } from '../app/filters'
import { credibleBounds, credibleMassLabel, useAlgorithmSettings } from '../app/algorithm-settings'
import { signedPoints } from '../app/presentation'
import { evidenceThresholds, meaningfulDeltaPoints, priorSourceLabel, reliabilityLabel, reliabilityTone, resolvedReliability } from '../app/reliability'
import { DataExplorer, type DataVisualItem } from './DataExplorer'
import { ChampionAvatar, EmptyState, EvidenceBar, StatusBadge } from './ui'

export function MatchupList({ items, direction }: { items: MatchupItemDto[]; direction: 'loses' | 'beats' }) {
  const { credibleMass, settings } = useAlgorithmSettings()
  const thresholds = evidenceThresholds(settings)
  const filtered = items.filter((item) => direction === 'loses' ? item.losses_to > 0 : item.wins_against > 0)
  const firstActionableIndex = filtered.findIndex((item) => item.actionable)
  if (!filtered.length) {
    return (
      <EmptyState
        title="Segnale insufficiente"
        description={`Nessun confronto ha ancora dati sufficienti per ${direction === 'loses' ? 'consigliare un ban' : 'sconsigliare il ban'}.`}
      />
    )
  }
  const rows = filtered.map((item, index) => {
    const supportingSampleSize = item.effective_sample_size ?? item.games
    const personalSampleSize = item.decision_games ?? item.unique_games ?? item.personal_effective_sample_size ?? supportingSampleSize
    const reliability = resolvedReliability(item.reliability, personalSampleSize, item.actionable, thresholds)
    const deltaPoints = meaningfulDeltaPoints(item.meaningful_delta, thresholds)
    const lift = item.posterior_lift_pp ?? item.relative_delta_pp
    const posterior = item.posterior_win_rate
    const baseline = item.baseline_win_rate
    const interval = credibleBounds(item)
    const intervalLabel = credibleMassLabel(item.credible_mass ?? credibleMass)
    const directionProbability = direction === 'loses'
      ? item.probability_meaningful_disadvantage ?? item.direction_probability ?? item.probability_worse_than_baseline ?? item.direction_confidence
      : item.probability_meaningful_advantage ?? item.direction_probability ?? item.direction_confidence
    const badge = !item.actionable
      ? 'da osservare'
      : direction === 'loses'
        ? index === firstActionableIndex ? '#1 ban consigliato' : 'alternativa ban'
        : 'vantaggio supportato'
    const evidence = <>
      <p>Percentuale di vittorie stimata {pct(posterior, 1)} · riferimento {pct(baseline, 1)} · intervallo al {intervalLabel} della percentuale di vittorie {pct(interval.lower, 1)}–{pct(interval.upper, 1)}</p>
      <p>Percentuale di vittorie osservata {pct(item.win_rate_against, 1)} · indice pesato della revisione {pct(item.weighted_win_rate_against, 1)}. I pesi di attribuzione non cambiano gli esiti usati per la stima.</p>
      <EvidenceBar value={directionProbability ?? 0} label={`Probabilità di ${direction === 'loses' ? 'uno svantaggio' : 'un vantaggio'} di almeno ${deltaPoints} punti percentuali`} secondary={pct(directionProbability, 1)} />
      <small>Partite personali distinte {personalSampleSize.toLocaleString('it-IT', { maximumFractionDigits: 1 })} · totale a supporto {supportingSampleSize.toLocaleString('it-IT', { maximumFractionDigits: 1 })} · punto di partenza {priorSourceLabel(item.prior_source ?? 'global')} ({item.prior_games ?? 0} partite). La decisione richiede almeno {thresholds.minGames} partite personali e la soglia di probabilità corretta per i confronti.</small>
    </>
    const badges = <>
      <StatusBadge tone={item.actionable ? direction === 'loses' ? 'negative' : 'positive' : 'warning'}>{badge}</StatusBadge>
      <StatusBadge tone={reliabilityTone(reliability)}>{reliabilityLabel(reliability)}</StatusBadge>
    </>
    return { item, index, personalSampleSize, lift, badge, evidence, badges }
  })
  const visualItems: DataVisualItem[] = rows.map(({ item, personalSampleSize, lift, badge, evidence, badges }) => ({
    id: `${item.champion}-${direction}`,
    label: item.champion,
    image: item.icon_url,
    subtitle: `${badge} · ${item.games} partite osservate · incontrato nel ${pct(item.exposure_rate, 1)} delle partite`,
    value: lift,
    valueLabel: Number.isFinite(lift) ? signedPoints(lift) : '—',
    reference: 0,
    sample: personalSampleSize,
    sampleLabel: 'Partite personali distinte',
    tone: item.actionable ? direction === 'loses' ? 'negative' : 'positive' : 'warning',
    details: <>{badges}{evidence}</>,
  }))

  return (
    <DataExplorer
      id={`matchups-${direction}`}
      label={direction === 'loses' ? 'Matchup di difficoltà' : 'Matchup di vantaggio'}
      items={visualItems}
      metricLabel="Differenza stimata rispetto al rendimento abituale"
      valueSuffix=" pp"
      sampleLabel="Partite personali distinte"
    >
      <div className="matchup-list">
        {rows.map(({ item, index, lift, evidence, badges }) => <article className="matchup-row" data-direction={direction} key={`${item.champion}-${direction}`}>
          <span className="row-rank">{String(index + 1).padStart(2, '0')}</span>
          <ChampionAvatar name={item.champion} src={item.icon_url} />
          <div className="matchup-row__main">
            <header>
              <strong>{item.champion}</strong>
              {badges}
            </header>
            <p>{item.games} partite osservate · incontrato nel {pct(item.exposure_rate, 1)} delle partite</p>
          </div>
          <div className="matchup-row__value">
            <strong>{signedPoints(lift)}</strong>
            <span>rispetto al tuo rendimento abituale</span>
          </div>
          <details className="matchup-row__details">
            <summary>Perché questo segnale?</summary>
            <div>{evidence}</div>
          </details>
        </article>)}
      </div>
    </DataExplorer>
  )
}
