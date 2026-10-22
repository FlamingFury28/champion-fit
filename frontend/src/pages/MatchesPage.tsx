import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { profileQuery, type MatchHistoryFilters } from '../api/queries'
import type { ProfileResponseDto } from '../api/types'
import { pct, ROLES } from '../app/filters'
import { MATCH_HISTORY_DEFAULTS, MATCH_HISTORY_PERIODS, MATCH_HISTORY_QUEUES, useMatchHistoryFilters } from '../app/match-history-filters'
import { destinations } from '../app/navigation'
import { queueLabel, roleLabel } from '../app/labels'
import { useScope } from '../app/scope'
import { RecentPerformance } from '../components/RecentPerformance'
import { SectionNavigation } from '../components/SectionNavigation'
import { EmptyState, ErrorState, MetricCard, PageHeader, Skeleton, Surface } from '../components/ui'
import '../matches.css'
import { AuditPage } from './AuditPage'
import { PlaystylesPage } from './PlaystylesPage'

const sections = [
  { id: 'history', label: 'Andamento e partite' },
  { id: 'style', label: 'Stile di gioco' },
] as const

function PersonalPerformance({ data }: { data: ProfileResponseDto }) {
  const { summary, recent, roles } = data
  return <div className="matches-performance" id="match-trend">
    <section className="metric-grid metric-grid--three" aria-label="Riepilogo delle partite">
      <MetricCard label="Partite" value={summary.games} detail={`${summary.wins} vittorie · ${summary.losses} sconfitte`} />
      <MetricCard label="Percentuale vittorie" value={pct(summary.win_rate, 1)} detail="Esiti osservati nello storico selezionato" tone="info" />
      <MetricCard label="Ruoli giocati" value={roles.length} detail={`${summary.champions_played} campioni distinti`} tone="neutral" />
    </section>
    <RecentPerformance compact matches={recent} title="Andamento recente" context="Ultime 20 partite nei filtri selezionati" />
    <Surface className="matches-roles" id="match-roles">
      <div className="section-heading"><div><p className="eyebrow">Distribuzione personale</p><h2>I tuoi ruoli</h2></div></div>
      {roles.length ? <div className="matches-role-grid">{roles.map((role) => <article key={role.role}>
        <strong>{roleLabel(role.role)}</strong>
        <span>{role.games} {role.games === 1 ? 'partita' : 'partite'}</span>
        <b>{pct(role.win_rate, 1)} vittorie</b>
      </article>)}</div> : <EmptyState title="Nessun ruolo osservato" description="Lo storico selezionato non contiene ancora partite classificabili per ruolo." />}
    </Surface>
  </div>
}

function MatchHistory() {
  const { scope, scopeReady } = useScope()
  const { filters, updateFilters, storageAvailable } = useMatchHistoryFilters()
  const profile = useQuery({ ...profileQuery(scope, filters), enabled: scopeReady })
  const championOptions = profile.data?.champion_options ?? profile.data?.champions.map((item) => item.champion) ?? []
  const champions = [...new Set([...championOptions, ...(filters.champion ? [filters.champion] : [])])].sort()

  return <>
    <div className="matches-filters" role="group" aria-label="Filtri delle partite">
      <label>Campione<select value={filters.champion} onChange={(event) => updateFilters({ champion: event.target.value })}>
        <option value="">Tutti i campioni</option>{champions.map((champion) => <option key={champion} value={champion}>{champion}</option>)}
      </select></label>
      <label>Ruolo<select value={filters.role} onChange={(event) => updateFilters({ role: event.target.value })}>
        {!ROLES.includes(filters.role as typeof ROLES[number]) ? <option value={filters.role} disabled>Ruolo del link: {filters.role}</option> : null}
        {ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
      </select></label>
      <label>Modalità<select value={filters.queue} onChange={(event) => updateFilters({ queue: event.target.value })}>
        {!['all', ...MATCH_HISTORY_QUEUES].includes(filters.queue) ? <option value={filters.queue} disabled>Modalità del link: {filters.queue}</option> : null}
        <option value="all">Tutte le modalità</option>{MATCH_HISTORY_QUEUES.map((queue) => <option key={queue} value={queue}>{queueLabel(queue)}</option>)}
      </select></label>
      <label>Periodo<select value={filters.days} onChange={(event) => updateFilters({ days: event.target.value })}>
        {!MATCH_HISTORY_PERIODS.includes(filters.days) ? <option value={filters.days} disabled>Periodo del link: {filters.days}</option> : null}
        {MATCH_HISTORY_PERIODS.map((days) => <option key={days} value={days}>{days === 'all' ? 'Tutto lo storico' : `Ultimi ${days} giorni`}</option>)}
      </select></label>
      <button className="button button--ghost" type="button" disabled={Object.entries(filters).every(([key, value]) => value === MATCH_HISTORY_DEFAULTS[key as keyof MatchHistoryFilters])} onClick={() => updateFilters(MATCH_HISTORY_DEFAULTS)}>Azzera filtri</button>
    </div>
    <p className="context-note">Statistiche sull’intero storico filtrato · elenco a gruppi di 24. {storageAvailable ? 'Le modifiche ai filtri vengono ricordate in questo browser.' : 'Il browser non consente di ricordare i filtri: conserva il link per ritrovarli.'}</p>
    <nav className="context-navigation" aria-label="Vai alle informazioni sulle partite"><a href="#match-trend">Andamento</a><a href="#match-roles">Ruoli</a><a href="#match-history">Partite e annotazioni</a></nav>
    {profile.isPending ? <Skeleton lines={7} label="Caricamento andamento personale" /> : profile.isError ? <ErrorState error={profile.error} onRetry={() => void profile.refetch()} /> : profile.data ? <PersonalPerformance data={profile.data} /> : null}
    <section id="match-history"><AuditPage embedded filters={filters} /></section>
  </>
}

export function MatchesPage() {
  const [params] = useSearchParams()
  const section = params.get('section') === 'style' ? 'style' : 'history'

  return <div className="page-stack matches-page">
    <PageHeader eyebrow="Profilo / Partite" title="Le mie partite" copy="Segui l’andamento personale, rivedi e annota le partite, oppure analizza gli stili di gioco nello stesso contesto." />
    <SectionNavigation path={destinations.matches} active={section} label="Sezioni delle mie partite" items={sections} />
    {section === 'style' ? <PlaystylesPage embedded /> : <MatchHistory />}
  </div>
}

export default MatchesPage
