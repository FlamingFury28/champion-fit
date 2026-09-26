import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { scopeQuery, type ScopeSnapshot } from '../api/client'
import { recommendationEvidenceQuery } from '../api/queries'
import type { RecommendationDto } from '../api/types'
import { formatDate, pct } from '../app/filters'
import { credibleBounds, credibleMassLabel, useAlgorithmSettings } from '../app/algorithm-settings'
import { championHref } from '../app/navigation'
import { useContentMotion } from '../app/surface-motion'
import { queueLabel, roleLabel, translateModelText } from '../app/labels'
import { ChampionAvatar, DataTable, EmptyState, ErrorState, Skeleton, StatusBadge } from './ui'

interface RecommendationCardProps {
  item: RecommendationDto
  scope: ScopeSnapshot
  rank?: number
  conflict?: boolean
  explanationOnly?: boolean
}

const number = (value: number) => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(value)
const weight = (value: number) => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 4 }).format(value)
const boundedPercent = (value: number) => Math.max(0, Math.min(100, value))
const uncertaintyLabels = { high: 'alta', medium: 'media', low: 'bassa' } as const
const contributionLabels = { positive: 'A favore', negative: 'A sfavore', excluded: 'Esclusa dall’attribuzione' } as const

export function RecommendationCard(props: RecommendationCardProps) {
  // Remount local disclosure and pagination when their data context changes.
  const identity = JSON.stringify([scopeQuery(props.scope), props.item.champion, props.item.role])
  return <ScopedRecommendationCard key={identity} {...props} />
}

function ScopedRecommendationCard({ item, scope, rank = 1, conflict = false, explanationOnly = false }: RecommendationCardProps) {
  const { credibleMass } = useAlgorithmSettings()
  const interval = credibleBounds(item)
  const intervalLabel = credibleMassLabel(item.credible_mass ?? credibleMass)
  const [params] = useSearchParams()
  const [expanded, setExpanded] = useState(false)
  const [matchesShown, setMatchesShown] = useState(false)
  const [offset, setOffset] = useState(0)
  const explanationMotion = useContentMotion(String(expanded), true)
  const detailsId = useId()
  const matchesId = useId()
  const evidence = useQuery({
    ...recommendationEvidenceQuery(scope, item.champion, item.role, offset),
    enabled: expanded && matchesShown,
  })
  const explanation = item.explanation
  const actionable = item.actionable && !conflict
  const tableLabel = `Partite a supporto di ${item.champion} in ${roleLabel(item.role)}`
  const detailHref = championHref(item.champion, item.role, params)

  return (
    <article className="recommendation-card" data-conflict={conflict} data-expanded={expanded}>
      {!explanationOnly ? <><div className="recommendation-card__heading">
        <span className="row-rank">{String(rank).padStart(2, '0')}</span>
        <ChampionAvatar name={item.champion} />
        <span className="answer-ranking__identity"><strong>{item.champion}</strong><small>{roleLabel(item.role, true)} · {item.unique_games ?? item.games} partite distinte</small></span>
        <span className="answer-ranking__score"><strong>{pct(item.posterior_fit, 0)}</strong><small>vittorie stimate</small><small>limite prudente {intervalLabel} · {pct(item.score, 0)}</small></span>
      </div>
      <nav className="recommendation-card__actions" aria-label={`Azioni per ${item.champion} ${roleLabel(item.role)}`}>
        <Link className="button button--compact" to={detailHref}>Apri la scheda completa <ArrowRight aria-hidden="true" /></Link>
      </nav></> : null}
      {conflict && !explanationOnly ? <p className="recommendation-card__conflict">Segnale contraddittorio: compare anche tra i campioni da mettere in pausa nei dati selezionati. Verifica prima di decidere.</p> : null}
      <div className="recommendation-card__disclosure">
        <button type="button" className="recommendation-card__toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
          Perché {item.champion} in {roleLabel(item.role)}? <ChevronDown aria-hidden="true" />
        </button>
        <StatusBadge tone={actionable ? 'positive' : 'warning'}>{actionable ? 'Scelta supportata' : 'Segnale da verificare'}</StatusBadge>
        <StatusBadge tone={explanation?.uncertainty_level === 'low' ? 'info' : 'warning'}>
          {explanation ? `Incertezza ${uncertaintyLabels[explanation.uncertainty_level]}` : 'Incertezza da valutare'}
        </StatusBadge>
      </div>
      <div ref={explanationMotion} id={detailsId} className="recommendation-explanation" hidden={!expanded}>
        <p className="recommendation-explanation__summary">{translateModelText(explanation?.summary || item.reason)}</p>
        <div className="recommendation-interval">
          <div className="recommendation-interval__values"><span>Percentuale di vittorie stimata <strong>{pct(item.posterior_fit, 1)}</strong></span><span>Intervallo credibile al {intervalLabel} <strong>{pct(interval.lower, 1)}–{pct(interval.upper, 1)}</strong></span></div>
          <div className="recommendation-interval__rail" aria-hidden="true">
            <span className="recommendation-interval__range" style={{ left: `${boundedPercent(interval.lower ?? 0)}%`, width: `${Math.max(0, boundedPercent(interval.upper ?? 0) - boundedPercent(interval.lower ?? 0))}%` }} />
            <span className="recommendation-interval__estimate" style={{ left: `${boundedPercent(item.posterior_fit)}%` }} />
          </div>
          <div className="recommendation-interval__scale" aria-hidden="true"><span>0%</span><span>100%</span></div>
          <p>Percentuale di vittorie osservata {pct(item.raw_win_rate, 1)} · riferimento {pct(item.baseline_win_rate, 1)}. La stima usa gli esiti delle partite con un’ipotesi iniziale prudente; un intervallo ampio indica incertezza.</p>
          <p>{item.probabilities_are_lower_bounds ? 'Limite inferiore della probabilità' : 'Probabilità'} di superare il riferimento di almeno 3 punti percentuali: {pct(item.probability_meaningful_advantage, 1)} · soglia richiesta {pct(item.decision_threshold, 1)}. Servono anche almeno 20 partite personali distinte: il solo piazzamento in classifica non rende il segnale operativo.</p>
          {item.probabilities_are_lower_bounds ? <p>Gli account hanno uguale peso. Un limite inferiore basso non significa che la probabilità reale sia così bassa: indica che i dati non permettono di garantirne una maggiore. Copertura: {item.observed_account_count} su {item.account_count} account.</p> : null}
        </div>
        {explanation ? (
          <>
            <dl className="recommendation-evidence-stats">
              <div><dt>Le tue partite e la revisione</dt><dd>{item.unique_games ?? item.games} partite distinte · {number(item.effective_evidence)} di peso attribuito nella revisione</dd><dd>{number(explanation.positive_evidence)} a favore · {number(explanation.negative_evidence)} a sfavore nella revisione</dd></div>
              <div><dt>Ipotesi iniziale del modello</dt><dd>Percentuale di vittorie iniziale {pct(explanation.prior_fit, 1)} · peso {number(explanation.prior_evidence)}</dd><dd>{pct(explanation.prior_share, 0)} del peso della stima è assegnato all’ipotesi iniziale indipendente.</dd></div>
            </dl>
            <p className="recommendation-explanation__note">I pesi della revisione descrivono l’attribuzione del risultato e restano consultabili partita per partita. La stima di vittoria conta gli esiti effettivi: ridurre il peso di una sconfitta non la trasforma in una vittoria e non restringe il suo intervallo.</p>
            <div className="recommendation-uncertainty"><strong>Perché l’incertezza è {uncertaintyLabels[explanation.uncertainty_level]}</strong><ul>{explanation.uncertainty_reasons.map((reason, index) => <li key={`${index}-${reason}`}>{translateModelText(reason)}</li>)}</ul></div>
            <p className="recommendation-next-step"><strong>Prossimo passo.</strong> {translateModelText(explanation.next_step)}</p>
          </>
        ) : <p className="recommendation-explanation__note">La scomposizione tra ipotesi iniziale ed evidenza personale non è disponibile per questo risultato.</p>}
        <button type="button" className="button button--secondary button--compact" aria-expanded={matchesShown} aria-controls={matchesId} onClick={() => setMatchesShown(!matchesShown)}>{matchesShown ? 'Nascondi le partite' : 'Mostra le partite'}</button>
        <div id={matchesId} className="recommendation-matches" hidden={!matchesShown}>
          {matchesShown && expanded ? (
            <>
              {evidence.isPending ? <Skeleton lines={3} label={`Caricamento partite di ${item.champion}`} /> : null}
              {evidence.isError ? <ErrorState title="Partite non disponibili" error={evidence.error} onRetry={() => void evidence.refetch()} /> : null}
              {!evidence.isPending && !evidence.isError && evidence.data ? (
                <>
                  <p className="recommendation-matches__summary">{evidence.data.summary.games} partite nei dati selezionati · {evidence.data.summary.wins} vittorie · {evidence.data.summary.losses} sconfitte. Nella revisione: {evidence.data.summary.discounted_games} con peso ridotto, {evidence.data.summary.excluded_games} escluse dall’attribuzione.</p>
                  <p className="recommendation-explanation__note">Una stessa partita può comparire più volte se giocata da più account selezionati. La stima confronta gli esiti per account; il numero minimo di partite richiesto per un consiglio conta le partite distinte, senza moltiplicarle per il numero di account.</p>
                  {evidence.data.items.length ? (
                    <DataTable label={tableLabel} aria-label={tableLabel}>
                      <thead><tr><th>Partita</th><th>Esito</th><th>Contributo alla revisione</th><th>Motivo del peso</th></tr></thead>
                      <tbody>{evidence.data.items.map((match) => (
                        <tr key={`${match.account}-${match.match_id}`}>
                          <th scope="row"><span className="recommendation-match__id">{match.match_id}</span><small><span>{match.account}</span> · <time dateTime={match.date}>{formatDate(match.date)}</time></small><small>{queueLabel(match.queue)} · {number(match.duration_minutes)} min</small></th>
                          <td><StatusBadge tone={match.win ? 'positive' : 'negative'}>{match.win ? 'Vittoria' : 'Sconfitta'}</StatusBadge></td>
                          <td><strong>Peso {weight(match.evidence_weight)}</strong><small>{contributionLabels[match.contribution]}</small></td>
                          <td>{translateModelText(match.weight_reason)}</td>
                        </tr>
                      ))}</tbody>
                    </DataTable>
                  ) : <EmptyState title="Nessuna partita da mostrare" description="Non ci sono partite disponibili per questo campione e ruolo nei dati selezionati." />}
                  {evidence.data.total > evidence.data.limit || offset > 0 ? (
                    <nav className="recommendation-pagination" aria-label={`Paginazione partite di ${item.champion}`}>
                      <button type="button" className="button button--ghost button--compact" disabled={offset === 0 || evidence.isFetching} onClick={() => setOffset(Math.max(0, offset - evidence.data!.limit))}>Partite precedenti</button>
                      <span role="status">{evidence.data.items.length ? `${offset + 1}–${offset + evidence.data.items.length}` : '0'} di {evidence.data.total}</span>
                      <button type="button" className="button button--ghost button--compact" disabled={offset + evidence.data.limit >= evidence.data.total || evidence.isFetching} onClick={() => setOffset(offset + evidence.data!.limit)}>Partite successive</button>
                    </nav>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </article>
  )
}
