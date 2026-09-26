import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { profileQuery } from '../api/queries'
import { pct } from '../app/filters'
import { destinations } from '../app/navigation'
import { roleLabel } from '../app/labels'
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

function PersonalPerformance() {
  const { scope, scopeReady } = useScope()
  const profile = useQuery({ ...profileQuery(scope), enabled: scopeReady })

  if (profile.isPending) return <Skeleton lines={7} label="Caricamento andamento personale" />
  if (profile.isError) return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
  if (!profile.data) return null

  const { summary, recent, roles } = profile.data
  return <div className="matches-performance" id="match-trend">
    <section className="metric-grid metric-grid--three" aria-label="Riepilogo delle partite">
      <MetricCard label="Partite" value={summary.games} detail={`${summary.wins} vittorie · ${summary.losses} sconfitte`} />
      <MetricCard label="Percentuale vittorie" value={pct(summary.win_rate, 1)} detail="Esiti osservati nello storico selezionato" tone="info" />
      <MetricCard label="Ruoli giocati" value={roles.length} detail={`${summary.champions_played} campioni distinti`} tone="neutral" />
    </section>
    <RecentPerformance compact matches={recent} title="Andamento recente" context="Account selezionati · finestra recente disponibile" />
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

export function MatchesPage() {
  const [params] = useSearchParams()
  const section = params.get('section') === 'style' ? 'style' : 'history'

  return <div className="page-stack matches-page">
    <PageHeader eyebrow="Profilo / Partite" title="Le mie partite" copy="Segui l’andamento personale, rivedi e annota le partite, oppure analizza gli stili di gioco nello stesso contesto." />
    <SectionNavigation path={destinations.matches} active={section} label="Sezioni delle mie partite" items={sections} />
    {section === 'style' ? <PlaystylesPage embedded /> : <>
      <p className="context-note" role="status">Riepilogo e revisione usano tutti i ruoli, tutte le modalità e tutto lo storico degli account selezionati. L’elenco mostra fino alle 24 partite più recenti che corrispondono al filtro “Mostra”.</p>
      <nav className="context-navigation" aria-label="Vai alle informazioni sulle partite"><a href="#match-trend">Andamento</a><a href="#match-roles">Ruoli</a><a href="#match-history">Partite e annotazioni</a></nav>
      <PersonalPerformance />
      <section id="match-history"><AuditPage embedded /></section>
    </>}
  </div>
}

export default MatchesPage
