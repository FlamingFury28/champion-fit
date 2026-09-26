import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { trainingPlanQuery } from '../api/queries'
import { clampInteger, normalizeRole, ROLES, pct } from '../app/filters'
import { queueLabel, roleLabel } from '../app/labels'
import { championHref } from '../app/navigation'
import { useScope } from '../app/scope'
import { ChampionAvatar, DataTable, DecisionSummary, EmptyState, ErrorState, FilterBar, MetricCard, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

const playableRoles = ROLES.filter((role) => role !== 'ALL')

function periodLabel(days: unknown) {
  if (String(days) === 'all') return 'tutto lo storico'
  return days ? `ultimi ${days} giorni` : 'periodo predefinito'
}

export function CompetitivePlanPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const explicitRole = params.get('role') ?? ''
  const role = params.has('role') ? normalizeRole(explicitRole) : undefined
  const queue = params.get('queue') ?? ''
  const days = params.get('days') ?? ''
  const budgetParam = params.get('budget') ?? params.get('n')
  const budget = clampInteger(budgetParam, 20, 2000, 400)
  const filters = { queue: queue || undefined, days: days || undefined }
  const result = useQuery({ ...trainingPlanQuery(scope, budget, role, filters), enabled: scopeReady })
  const data = result.data
  const update = (key: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })
  const accountsLabel = scope.accounts.length ? scope.accounts.join(', ') : 'tutti gli account attivi'
  const context = data?.context ?? {}
  const items = [...(data?.items ?? [])].sort((left, right) => right.allocation_games - left.allocation_games
    || (right.posterior_win_rate ?? 0) - (left.posterior_win_rate ?? 0)
    || left.champion.localeCompare(right.champion, 'it'))
  const first = items.find((item) => item.allocation_games > 0) ?? items[0]

  return <div className="page-stack">
    <PageHeader level={embedded ? 2 : 1} eyebrow="Campioni / Piano competitivo" title="Piano da 400 partite" copy="Distribuisci un budget per capire quale campione può diventare la scelta migliore. Il piano confronta candidati promettenti con il miglior riferimento storico disponibile." aside={result.isFetching && data ? <StatusBadge tone="info">Ricalcolo</StatusBadge> : undefined} />

    <DecisionSummary
      answer={first ? `Parti da ${first.champion} · ${roleLabel(first.role)}` : 'Nessun candidato nel contesto selezionato'}
      detail={data?.model?.message ?? 'Il piano usa una simulazione gerarchica e resta esplorativo finché non supera la validazione temporale.'}
      status={data?.model?.validated ? 'Modello convalidato' : 'Piano esplorativo'}
      tone={data?.model?.validated ? 'positive' : 'warning'}
    />

    <FilterBar>
      <div className="filter-bar__intro"><strong>Budget e contesto</strong><span>Account attivi: {accountsLabel}. Il budget è il totale di partite da distribuire.</span></div>
      <label>Partite<input aria-label="Budget partite" type="number" min={20} max={2000} step={1} value={budget} onChange={(event) => update('budget', String(clampInteger(event.target.value, 20, 2000, 400)))} /></label>
      <label>Ruolo<select value={explicitRole} onChange={(event) => update('role', event.target.value)}><option value="">Automatico</option><option value="ALL">Tutti i ruoli</option>{playableRoles.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
      <label>Modalità<select value={queue} onChange={(event) => update('queue', event.target.value)}><option value="">Predefinita</option><option value="all">Tutte le modalità</option>{['420', '440', '400', '430', '490', '480', '700'].map((value) => <option key={value} value={value}>{queueLabel(value)}</option>)}</select></label>
      <label>Periodo<select value={days} onChange={(event) => update('days', event.target.value)}><option value="">Predefinito</option><option value="90">90 giorni</option><option value="180">180 giorni</option><option value="365">365 giorni</option><option value="all">Tutto lo storico</option></select></label>
      <span className="filter-count" role="status">{data ? `${data.budget_assigned}/${data.budget_total} partite assegnate` : `${budget} partite richieste`}</span>
    </FilterBar>

    {result.isPending ? <Skeleton lines={8} label="Calcolo della distribuzione competitiva" /> : null}
    {result.isError ? <ErrorState title="Piano competitivo non disponibile" error={result.error} onRetry={() => void result.refetch()} /> : null}
    {data ? <>
      <section className="metric-grid metric-grid--three" aria-label="Riepilogo del piano">
        <MetricCard label="Partite allocate" value={`${data.budget_assigned}/${data.budget_total}`} detail={data.budget_unassigned ? `${data.budget_unassigned} non assegnate per mancanza di candidati` : 'Somma dei conteggi interi'} tone={data.budget_unassigned ? 'warning' : 'positive'} />
        <MetricCard label="Candidati al confronto" value={items.length} tone="info" />
        <MetricCard label="Riduzione attesa del rimpianto" value={data.expected_regret_reduction == null ? '—' : pct(data.expected_regret_reduction * 100)} detail={data.monte_carlo_se == null ? 'Valore non stimabile' : `errore Monte Carlo ±${pct(data.monte_carlo_se * 100)}`} tone="warning" />
      </section>

      <Surface><div className="section-heading"><div><p className="eyebrow">Contesto effettivo</p><h2>{roleLabel(String(context.role ?? ''))} · {queueLabel(String(context.queue ?? ''))}</h2></div><StatusBadge tone="neutral">{periodLabel(context.days)}</StatusBadge></div><p className="section-copy">Obiettivo: scegliere il campione migliore dopo le partite nuove riducendo il rimpianto atteso. L’allocatore simula esiti Bernoulli dai posteriori gerarchici; usa un’euristica greedy con scenari casuali riproducibili, non garantisce l’ottimo globale né il risultato di un torneo.</p></Surface>

      <QueryResults label="Piano per identificare il campione migliore" aria-busy={result.isFetching}>
        {items.length ? <DataTable label="Partite competitive assegnate per campione"><thead><tr><th>Campione</th><th>Ruolo</th><th>Partite osservate</th><th>Stima aggiustata</th><th>Segnale</th><th>Nuove partite</th><th>Account coinvolti</th><th>Dettaglio</th></tr></thead><tbody>{items.map((item) => {
          const detail = championHref(item.champion, item.role, params)
          const signal = item.historical_supported
            ? { text: 'Vantaggio storico supportato', tone: 'warning' as const }
            : item.classification === 'promising'
              ? { text: 'Positivo da verificare', tone: 'info' as const }
              : { text: 'Riferimento', tone: 'neutral' as const }
          const assignedAccounts = item.account_allocations.filter((entry) => entry.games > 0)
          return <tr key={`${item.champion}-${item.role}`}>
            <th scope="row"><Link className="champion-link champion-link--interactive" state={{ championSheetFromList: true }} to={detail}><ChampionAvatar name={item.champion} src={item.icon_url} size="sm" /><span>{item.champion}</span></Link></th>
            <td>{roleLabel(item.role)}</td>
            <td className="numeric">{item.unique_games}</td>
            <td className="numeric">{pct(item.posterior_win_rate)}</td>
            <td><StatusBadge tone={signal.tone}>{signal.text}</StatusBadge></td>
            <td className="numeric numeric--hero">{item.allocation_games}</td>
            <td><details><summary>{assignedAccounts.length} account</summary><ul>{assignedAccounts.map((entry) => <li key={entry.account}>{entry.account}: {entry.games}</li>)}</ul></details></td>
            <td><Link className="text-link" state={{ championSheetFromList: true }} to={detail}>Apri <ArrowRight aria-hidden="true" /></Link></td>
          </tr>
        })}</tbody></DataTable> : <EmptyState title="Nessun candidato nel contesto corrente" description="Non ci sono esiti storici sufficienti per simulare una scelta. Cambia account, ruolo, modalità o periodo." />}
      </QueryResults>
      <aside className="context-note"><strong>Le preferenze restano separate</strong><p>Questo è un piano di identificazione basato sui risultati binari. Il ciclo breve “Piano di prove” continua a proporre campioni affini ai tuoi gusti, una partita per candidato.</p></aside>
    </> : null}
  </div>
}
