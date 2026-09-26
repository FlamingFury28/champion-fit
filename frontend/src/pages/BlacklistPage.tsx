import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Ban, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router'
import { blacklistQuery } from '../api/queries'
import type { BlacklistItemDto } from '../api/types'
import { pct } from '../app/filters'
import { credibleBounds, credibleMassLabel, useAlgorithmSettings } from '../app/algorithm-settings'
import { roleLabel } from '../app/labels'
import { technicalText } from '../app/presentation'
import { useScope } from '../app/scope'
import { ChampionAvatar, DecisionSummary, EmptyState, ErrorState, MetricCard, PageHeader, Skeleton, StatusBadge, Surface } from '../components/ui'

function BlacklistColumn({ title, copy, items, strong }: { title: string; copy: string; items: BlacklistItemDto[]; strong: boolean }) {
  const { credibleMass } = useAlgorithmSettings()
  return (
    <Surface className={strong ? 'blacklist-column blacklist-column--strong' : 'blacklist-column'}>
      <div className="section-heading"><div><p className="eyebrow">{strong ? 'Decisione per questo ciclo' : 'Non decidere ancora'}</p><h2>{title}</h2></div><StatusBadge tone={strong ? 'negative' : 'warning'}>{items.length}</StatusBadge></div>
      <p className="section-copy">{copy}</p>
      {items.length ? <div className="blacklist-list">{items.map((item) => (
        <article key={`${item.champion}-${item.role}`}>
          <ChampionAvatar name={item.champion} src={item.icon_url} />
          <div>
            <header><strong>{item.champion}</strong><StatusBadge tone={strong ? 'negative' : 'warning'}>{roleLabel(item.role, true)}</StatusBadge></header>
            <p>{technicalText(item.reason)}</p>
            <small>{item.games_observed ?? 0} partite · percentuale di vittorie osservata {pct(item.account_adjusted_fit_score)}</small>
            {item.posterior_win_rate != null ? <small>Vittorie stimate {pct(item.posterior_win_rate, 1)} · intervallo al {credibleMassLabel(item.credible_mass ?? credibleMass)} {pct(credibleBounds(item).lower, 1)}–{pct(credibleBounds(item).upper, 1)}</small> : null}
            <small>Peso delle sconfitte nella revisione partite: {Number(item.informative_losses_equivalent ?? 0).toFixed(1)}</small>
            <nav className="blacklist-item__actions" aria-label={`Azioni per ${item.champion} ${roleLabel(item.role)}`}>
              <Link to={`/app/fit?role=${item.role}`}>Trova un’alternativa</Link>
              <Link to="/app/review/audit?flag=loss">Rivedi le sconfitte</Link>
            </nav>
          </div>
        </article>
      ))}</div> : <EmptyState title="Nessun campione" description="I dati selezionati non producono decisioni in questo livello." />}
    </Surface>
  )
}

export function BlacklistPage() {
  const { scope, scopeReady } = useScope()
  const blacklist = useQuery({ ...blacklistQuery(scope), enabled: scopeReady })
  const strong = blacklist.data?.items.filter((item) => item.tier === 'strong' && item.actionable) ?? []
  const provisional = blacklist.data?.items.filter((item) => item.tier === 'provisional' || !item.actionable) ?? []
  const strongStop = strong[0]
  const provisionalStop = provisional[0]
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Risposta / Chi non giocare"
        title={<>Chi non dovresti più giocare, <em>per ora?</em></>}
        copy="Prima trovi la decisione pronta. I segnali ancora incerti restano separati e non diventano automaticamente un consiglio di pausa."
        aside={<StatusBadge tone="negative"><Ban aria-hidden="true" /> sola lettura</StatusBadge>}
      />
      <p className="context-note" role="status">Contesto: tutti i ruoli, tutte le modalità e tutto lo storico degli account selezionati.</p>
      {blacklist.isPending ? <Skeleton lines={8} /> : null}
      {blacklist.isError ? <ErrorState error={blacklist.error} onRetry={() => void blacklist.refetch()} /> : null}
      {blacklist.data ? (
        <>
          <DecisionSummary
            answer={strongStop ? `Metti in pausa ${strongStop.champion} · ${roleLabel(strongStop.role)}` : 'Non fermare ancora nessuno'}
            detail={strongStop
              ? technicalText(strongStop.reason)
              : provisionalStop ? `Controlla prima ${provisionalStop.champion} · ${roleLabel(provisionalStop.role)}: il segnale negativo è ancora provvisorio.` : 'Non ci sono dati sufficienti per mettere in pausa un campione.'}
            status={strongStop ? 'Pausa sostenuta dai dati' : provisionalStop ? 'Verifica necessaria' : 'Dati insufficienti'}
            tone={strongStop ? 'negative' : provisionalStop ? 'warning' : 'info'}
            action={strongStop
              ? <Link className="button" to={`/app/fit?role=${strongStop.role}`}>Trova un’alternativa <ArrowRight aria-hidden="true" /></Link>
              : provisionalStop ? <Link className="button button--secondary" to="/app/review/audit?flag=loss">Rivedi le sconfitte <ArrowRight aria-hidden="true" /></Link> : undefined}
          />
          {!blacklist.data.items.length ? (
            <EmptyState title="Nessun dettaglio da approfondire" description="Nessuna coppia campione + ruolo supera le soglie negative nei dati selezionati." />
          ) : (
            <div className="blacklist-layout">
              <BlacklistColumn title="Metti in pausa ora" copy="L'evidenza è sufficiente per evitare di investire altre partite nel ciclo corrente." items={strong} strong />
              <BlacklistColumn title="Tieni sotto osservazione" copy="Il segnale è negativo ma ancora incerto: può meritare una prova mirata prima di decidere." items={provisional} strong={false} />
            </div>
          )}
          <section className="metric-grid metric-grid--three">
            <MetricCard label="Da mettere in pausa" value={strong.length} tone="negative" />
            <MetricCard label="Ancora da verificare" value={provisional.length} tone="warning" />
            <MetricCard label="Account considerati" value={blacklist.data.scope_accounts.length || scope.accounts.length} tone="info" />
          </section>
          <div className="info-callout"><ShieldAlert aria-hidden="true" /><div><strong>Decisione, non divieto.</strong><p>Questa risposta non modifica i dati e non impedisce alcuna scelta: mostra quanto le partite osservate sconsigliano di insistere.</p></div></div>
        </>
      ) : null}
    </div>
  )
}
