import { useQuery } from '@tanstack/react-query'
import { Link2, Unlink, UsersRound } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { synergyQuery } from '../api/queries'
import type { MinimumReliability, SynergyItemDto } from '../api/types'
import { pct, ROLES } from '../app/filters'
import { queueLabel, roleLabel } from '../app/labels'
import { credibleBounds, credibleMassLabel, useAlgorithmSettings } from '../app/algorithm-settings'
import { isVisibleReliability, priorSourceLabel, reliabilityLabel, reliabilityTone, resolvedReliability } from '../app/reliability'
import { signedPoints } from '../app/presentation'
import { useScope } from '../app/scope'
import { DataExplorer, type DataVisualItem } from '../components/DataExplorer'
import { ChampionAvatar, EmptyState, ErrorState, EvidenceBar, FilterBar, MetricCard, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

const minimumReliabilityOptions: Array<{ value: MinimumReliability; label: string }> = [
  { value: 'weak', label: 'Debole o migliore · almeno 3 esiti' },
  { value: 'indicative', label: 'Indicativa o migliore · almeno 8 esiti' },
  { value: 'reliable', label: 'Affidabile · soglia decisionale superata' },
]

function parseMinimumReliability(value: string | null): MinimumReliability {
  return minimumReliabilityOptions.some((option) => option.value === value)
    ? value as MinimumReliability
    : 'weak'
}

type SynergySignal = {
  label: string
  tone: 'positive' | 'negative' | 'info' | 'warning' | 'neutral'
  detail: string
}

function synergySignal(item: SynergyItemDto, direction: 'positive' | 'negative', minGames: number): SynergySignal {
  if (item.actionable) {
    return {
      label: direction === 'positive' ? 'Vantaggio supportato' : 'Svantaggio supportato',
      tone: direction,
      detail: 'Il confronto supera la soglia statistica configurata.',
    }
  }
  if (item.mixed_role_context) {
    const lift = item.posterior_lift_pp ?? item.relative_delta_pp ?? item.win_rate - item.baseline_win_rate
    return {
      label: direction === 'positive' ? 'Multi-ruolo · stima sopra il riferimento' : 'Multi-ruolo · stima sotto il riferimento',
      tone: 'warning',
      detail: `Differenza stimata ${signedPoints(lift)}; è descrittiva perché il contesto comprende più ruoli. ${item.decision_reason || 'Seleziona un ruolo per confrontare partite omogenee.'}`,
    }
  }
  if (item.missing_accounts?.length || item.missing_baseline_accounts?.length || item.missing_role_baselines?.length) {
    return {
      label: 'Riferimento incompleto',
      tone: 'warning',
      detail: item.decision_reason || 'Manca un confronto omogeneo per almeno un account selezionato.',
    }
  }
  const games = item.decision_games ?? item.unique_games ?? item.games
  if (games < minGames) {
    return {
      label: 'Campione ridotto',
      tone: 'warning',
      detail: `Il campione personale è di ${games} partite; la soglia minima è ${minGames}.`,
    }
  }
  if (item.attribution_veto_applied) {
    return {
      label: 'Evidenza non sufficiente',
      tone: 'warning',
      detail: item.decision_reason || 'Le sconfitte non forniscono evidenza sufficiente per questa conclusione.',
    }
  }
  const probability = direction === 'positive'
    ? item.probability_meaningful_advantage
    : item.probability_meaningful_disadvantage
  const threshold = item.decision_threshold
  const directionLabel = direction === 'positive' ? 'favorevole' : 'sfavorevole'
  const thresholdText = threshold == null ? '' : `, sotto la soglia prudente del ${pct(threshold, 3)}`
  const familyText = item.family_size ? ` su ${item.family_size} confronti` : ''
  return {
    label: `Tendenza ${directionLabel} · non confermata`,
    tone: 'info',
    detail: `La probabilità di una differenza significativa è ${pct(probability, 1)}${thresholdText}${familyText}.`,
  }
}

function SynergyList({
  title,
  direction,
  items,
  minGames,
}: {
  title: string
  direction: 'positive' | 'negative'
  items: SynergyItemDto[]
  minGames: number
}) {
  const { credibleMass } = useAlgorithmSettings()
  const rows = items.map((item, index) => {
    const supportingSampleSize = item.effective_sample_size ?? item.games
    const personalSampleSize = item.personal_effective_sample_size ?? supportingSampleSize
    const posterior = item.posterior_win_rate ?? item.win_rate
    const baseline = item.baseline_win_rate ?? posterior
    const lift = item.posterior_lift_pp ?? item.relative_delta_pp ?? posterior - baseline
    const reliability = resolvedReliability(item.reliability, personalSampleSize, item.actionable)
    const directionProbability = direction === 'positive'
      ? item.probability_meaningful_advantage ?? item.direction_probability ?? item.direction_confidence
      : item.probability_meaningful_disadvantage ?? item.direction_probability ?? item.direction_confidence
    const signal = synergySignal(item, direction, minGames)
    const badges = <>
      <StatusBadge tone={reliabilityTone(reliability)}>{reliabilityLabel(reliability)}</StatusBadge>
      <StatusBadge tone={signal.tone}>{signal.label}</StatusBadge>
    </>
    const sampleDescription = `${item.games} partite osservate · ${personalSampleSize.toFixed(1)} partite personali distinte · ${supportingSampleSize.toFixed(1)} totali a supporto · ipotesi iniziale: ${priorSourceLabel(item.prior_source ?? 'global')} (${item.prior_games ?? 0} partite)`
    const evidence = <EvidenceBar value={directionProbability ?? 0} label="Probabilità di un effetto oltre 3 punti percentuali" secondary={pct(directionProbability, 1)} />
    return { item, index, personalSampleSize, posterior, baseline, lift, reliability, signal, badges, sampleDescription, evidence }
  })
  const visualItems: DataVisualItem[] = rows.map(({ item, personalSampleSize, posterior, baseline, lift, signal, badges, sampleDescription, evidence }) => ({
    id: `${item.champion}-${direction}`,
    label: item.champion,
    image: item.icon_url,
    subtitle: `${signal.label} · ${item.games} partite osservate`,
    value: lift,
    valueLabel: Number.isFinite(lift) ? signedPoints(lift) : '—',
    reference: 0,
    sample: personalSampleSize,
    sampleLabel: 'Partite personali distinte',
    tone: item.actionable ? direction : signal.tone,
    details: <>
      {badges}
      <p>{signal.detail}</p>
      <p>Percentuale di vittorie stimata {pct(posterior, 1)} · riferimento {pct(baseline, 1)} · intervallo {credibleMassLabel(item.credible_mass ?? credibleMass)} della percentuale di vittorie {pct(credibleBounds(item).lower, 1)}–{pct(credibleBounds(item).upper, 1)}</p>
      <p>Percentuale di vittorie osservata {pct(item.win_rate, 1)}</p>
      <p>{sampleDescription}</p>
      {evidence}
    </>,
  }))

  return (
    <Surface>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{direction === 'positive' ? 'Differenza stimata positiva' : 'Differenza stimata negativa'}</p>
          <h2>{title}</h2>
        </div>
        <StatusBadge tone={direction}>{items.length} segnali</StatusBadge>
      </div>
      {items.length ? (
        <DataExplorer
          id={`synergies-${direction}`}
          label={`Sinergie: ${title.toLocaleLowerCase('it')}`}
          items={visualItems}
          metricLabel="Differenza stimata rispetto al riferimento"
          valueSuffix=" pp"
          sampleLabel="Partite personali distinte"
        >
          <div className="synergy-list">
            {rows.map(({ item, index, posterior, baseline, lift, reliability, signal, badges, sampleDescription, evidence }) => (
              <article data-reliability={reliability} data-tone={direction} key={`${item.champion}-${direction}`}>
                <span className="row-rank">{String(index + 1).padStart(2, '0')}</span>
                <ChampionAvatar name={item.champion} src={item.icon_url} />
                <div className="synergy-list__main">
                  <header>
                    <strong>{item.champion}</strong>
                    {badges}
                  </header>
                  <p>{signal.detail}</p>
                  <p>{sampleDescription}</p>
                  {evidence}
                </div>
                <div className="synergy-list__value">
                  <strong>{signedPoints(lift)}</strong>
                  <span>percentuale di vittorie stimata {pct(posterior, 1)} · riferimento {pct(baseline, 1)}</span>
                  <small>intervallo {credibleMassLabel(item.credible_mass ?? credibleMass)} · {pct(credibleBounds(item).lower, 1)}–{pct(credibleBounds(item).upper, 1)}</small>
                  <small>percentuale di vittorie osservata {pct(item.win_rate, 1)}</small>
                </div>
              </article>
            ))}
          </div>
        </DataExplorer>
      ) : (
        <EmptyState
          title="Nessun segnale con questa affidabilità"
          description="Abbassa l’affidabilità minima oppure abilita esplicitamente i segnali esplorativi."
        />
      )}
    </Surface>
  )
}

export function SynergyPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, state, scopeReady, availableAccounts, setAccounts, clearCompanion } = useScope()
  const [params, setParams] = useSearchParams()
  const champion = params.get('champion') || 'ALL'
  const minReliability = parseMinimumReliability(params.get('min_reliability'))
  const includeExploratory = params.get('include_exploratory') === '1'
  const requestedRole = (params.get('role') ?? 'ALL').toUpperCase()
  const requestedQueue = params.get('queue') ?? 'all'
  const requestedDays = params.get('days') ?? 'all'
  const filters = {
    minReliability,
    includeExploratory,
    role: ROLES.includes(requestedRole as typeof ROLES[number]) ? requestedRole : 'ALL',
    queue: ['all', '420', '440', '400', '430', '450', '480', '490', '700'].includes(requestedQueue) ? requestedQueue : 'all',
    days: ['all', '90', '180', '365'].includes(requestedDays) ? requestedDays : 'all',
  }
  const synergy = useQuery({ ...synergyQuery(scope, champion, filters), enabled: scopeReady })
  const contextRole = synergy.data?.context?.role ?? filters.role
  const contextQueue = synergy.data?.context?.queue ?? filters.queue
  const contextDays = synergy.data?.context?.days ?? filters.days
  const update = (key: string, value: string, fallback: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value === fallback) next.delete(key)
    else next.set(key, value)
    return next
  }, { replace: true })

  const betterWith = (synergy.data?.better_with ?? []).filter((item) => {
    const reliability = resolvedReliability(item.reliability, item.personal_effective_sample_size ?? item.effective_sample_size ?? item.games, item.actionable)
    return isVisibleReliability(reliability, minReliability, includeExploratory)
  })
  const worseWith = (synergy.data?.worse_with ?? []).filter((item) => {
    const reliability = resolvedReliability(item.reliability, item.personal_effective_sample_size ?? item.effective_sample_size ?? item.games, item.actionable)
    return isVisibleReliability(reliability, minReliability, includeExploratory)
  })

  return (
    <div className="page-stack">
      <PageHeader
        level={embedded ? 2 : 1}
        eyebrow="Campioni / Alleati"
        title="Con quali campioni alleati rendi meglio?"
        copy="Questi sono i campioni della tua squadra, non le persone con cui giochi. Il riepilogo parte da tutti i ruoli, modalità e storico. Per confrontare partite omogenee scegli un ruolo; ogni risultato spiega perché è confermato o ancora da verificare."
      />
      <FilterBar>
        <label>
          Ruolo
          <select value={filters.role} onChange={(event) => update('role', event.target.value, 'ALL')}>
            {ROLES.map((role) => <option key={role} value={role}>{role === 'ALL' ? 'Tutti i ruoli · aggregato' : roleLabel(role)}</option>)}
          </select>
        </label>
        <label>
          Modalità
          <select value={filters.queue} onChange={(event) => update('queue', event.target.value, 'all')}>
            <option value="all">Tutte le modalità · aggregato</option>
            {['420', '440', '400', '430', '450', '480', '490', '700'].map((queue) => <option key={queue} value={queue}>{queueLabel(queue)}</option>)}
          </select>
        </label>
        <label>
          Periodo
          <select value={filters.days} onChange={(event) => update('days', event.target.value, 'all')}>
            <option value="all">Tutto lo storico</option>
            <option value="90">Ultimi 90 giorni</option>
            <option value="180">Ultimi 180 giorni</option>
            <option value="365">Ultimi 365 giorni</option>
          </select>
        </label>
        <label>
          Campione giocato
          <select value={champion} onChange={(event) => update('champion', event.target.value, 'ALL')}>
            <option value="ALL">Tutti i campioni</option>
            {synergy.data?.available_champions.map((item) => <option key={item.champion} value={item.champion}>{item.champion} · {item.games} partite</option>)}
          </select>
        </label>
        <label>
          Affidabilità minima
          <select value={minReliability} onChange={(event) => update('min_reliability', event.target.value, 'weak')}>
            {minimumReliabilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="filter-toggle" htmlFor="include-exploratory">
          <input
            id="include-exploratory"
            aria-label="Mostra esplorativi"
            type="checkbox"
            checked={includeExploratory}
            onChange={(event) => update('include_exploratory', event.target.checked ? '1' : '0', '0')}
          />
          Mostra esplorativi <small>meno di 3 esiti · da confermare</small>
        </label>
        {state.companion ? <StatusBadge tone="warning">filtro sui compagni attivo</StatusBadge> : null}
        <span className="filter-count" role="status">{synergy.isFetching && !synergy.isPending ? 'Aggiornamento risultati…' : `${betterWith.length + worseWith.length} segnali`}</span>
      </FilterBar>
      <p className="context-note" role="status">Contesto richiesto{synergy.data ? ' ed effettivo' : ''}: {roleLabel(contextRole)} · {queueLabel(contextQueue)} · {String(contextDays) === 'all' ? 'tutto lo storico' : `${contextDays} giorni`}.</p>
      {synergy.isPending ? <Skeleton lines={8} /> : null}
      {synergy.isError ? <ErrorState error={synergy.error} onRetry={() => void synergy.refetch()} /> : null}
      {synergy.data ? (() => {
        const coverage = synergy.data.coverage ?? {
          raw_games: synergy.data.games,
          eligible_games: synergy.data.games,
          analyzed_games: synergy.data.games,
          games_with_roster: synergy.data.games_with_teammates,
          roster_coverage: synergy.data.games_with_teammates / Math.max(synergy.data.games, 1) * 100,
        }
        return <QueryResults label="Risultati delle sinergie" aria-busy={synergy.isFetching && !synergy.isPending}>
          <section className="metric-grid">
            <MetricCard label="Partite raccolte" value={coverage.raw_games} detail="prima dei filtri" />
            <MetricCard label="Partite ammesse" value={coverage.eligible_games} detail="nelle modalità incluse" tone="info" />
            <MetricCard label="Partite analizzate" value={coverage.analyzed_games} detail={`${synergy.data.games} con il filtro sul campione`} tone="warning" />
            <MetricCard label="Partite con partecipanti" value={coverage.games_with_roster} detail={`${pct(coverage.roster_coverage, 0)} delle partite filtrate`} tone="neutral" />
          </section>
          {synergy.data.games === 0 ? (
            <EmptyState
              title="Gli account selezionati non contengono partite analizzate"
              description="Champion Fit non cambia i dati usati in automatico. Scegli qui l’azione che vuoi applicare."
              action={<div className="empty-actions">
                {state.companion ? <button className="button button--secondary" type="button" onClick={clearCompanion}><Unlink aria-hidden="true" /> Ignora filtro sui compagni</button> : null}
                {scope.accounts.length < availableAccounts.length ? <button className="button button--secondary" type="button" onClick={() => setAccounts(availableAccounts.map((item) => item.account))}><UsersRound aria-hidden="true" /> Usa tutti gli account</button> : null}
              </div>}
            />
          ) : (
            <div className="matchup-grid">
              <SynergyList title="Sopra il riferimento" direction="positive" items={betterWith} minGames={synergy.data.min_games} />
              <SynergyList title="Sotto il riferimento" direction="negative" items={worseWith} minGames={synergy.data.min_games} />
            </div>
          )}
          {synergy.data.games > 0 && coverage.games_with_roster === 0 ? (
            <div className="info-callout"><Link2 aria-hidden="true" /><div><strong>Partecipanti non disponibili</strong><p>Le partite esistono, ma mancano i dati sui partecipanti necessari per calcolare le sinergie.</p></div></div>
          ) : null}
        </QueryResults>
      })() : null}
    </div>
  )
}
