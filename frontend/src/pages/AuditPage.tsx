import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Save } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { ApiError, postJson } from '../api/client'
import { invalidateAfterAnnotation } from '../api/invalidation'
import { annotationQuery, matchesQuery, queryKeys } from '../api/queries'
import type { AnnotationDto, AnnotationMutationResponseDto, AnnotationUpsertInput, MatchDto } from '../api/types'
import { formatDate, pct } from '../app/filters'
import { anomalyFlagsLabel, apiErrorLabel, queueLabel, roleLabel } from '../app/labels'
import { technicalText } from '../app/presentation'
import { useScope } from '../app/scope'
import { useToast } from '../components/toast'
import { ChampionAvatar, Drawer, EmptyState, ErrorState, FilterBar, PageHeader, Skeleton, StatusBadge } from '../components/ui'

const flags = [['contaminated', 'Sconfitte poco informative'], ['all', 'Tutte'], ['afk', 'Giocatori inattivi (AFK) o quasi inattivi'], ['loss', 'Tutte le sconfitte']]
const annotationFlags = [
  { key: 'invincible', label: 'Partita impossibile da vincere', effect: 'Su una sconfitta azzera il peso negativo nel calcolo.' },
  { key: 'carryable_loss', label: 'Sconfitta recuperabile', effect: 'Aggiunge contesto descrittivo; oggi non modifica il punteggio.' },
  { key: 'afk_player', label: 'Giocatore inattivo (AFK) in squadra', effect: 'Su una sconfitta azzera il peso negativo nel calcolo.' },
  { key: 'griefer', label: 'Giocatore che sabota', effect: 'Su una sconfitta azzera il peso negativo nel calcolo.' },
  { key: 'team_collapse', label: 'Crollo della squadra', effect: 'Aggiunge contesto descrittivo; oggi non modifica il punteggio.' },
] as const

function AnnotationEditor({ match, annotation, revision, onClose, onDirtyChange }: {
  match: MatchDto
  annotation: AnnotationDto | null
  revision: string | null
  onClose: (saved?: boolean) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [initialValues] = useState<AnnotationUpsertInput>(() => ({
    match_id: match.match_id,
    invincible: Boolean(annotation?.invincible),
    carryable_loss: Boolean(annotation?.carryable_loss),
    afk_player: Boolean(annotation?.afk_player),
    griefer: Boolean(annotation?.griefer),
    team_collapse: Boolean(annotation?.team_collapse),
    manual_label: annotation?.manual_label ?? '',
    note: annotation?.note ?? '',
    confidence: annotation?.confidence ?? 1,
    expected_revision: revision,
  }))
  const [values, setValues] = useState<AnnotationUpsertInput>(initialValues)
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValues)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const mutation = useMutation({
    mutationFn: (body: AnnotationUpsertInput) => postJson<AnnotationMutationResponseDto>('/api/annotations', body),
    onSuccess: async () => {
      await Promise.all([
        invalidateAfterAnnotation(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.annotation(match.match_id) }),
      ])
      notify('Annotazione salvata', { description: match.match_id, tone: 'success' })
      onClose(true)
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.annotation(match.match_id) })
        notify('Annotazione aggiornata altrove', { description: 'Ho ricaricato i dati correnti. Controllali e riprova.', tone: 'error' })
        return
      }
      notify('Salvataggio non riuscito', { description: apiErrorLabel(error.message), tone: 'error' })
    },
  })
  const toggle = (key: keyof Pick<AnnotationUpsertInput, 'invincible' | 'carryable_loss' | 'afk_player' | 'griefer' | 'team_collapse'>) => setValues((current) => ({ ...current, [key]: !current[key] }))
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(values) }

  return (
    <form className="annotation-form" onSubmit={submit}>
      <div className="annotation-match"><ChampionAvatar name={match.champion} src={match.icon_url} size="lg" /><div><strong>{match.champion} · {roleLabel(match.role)}</strong><span>{match.account} · {formatDate(match.date)}</span><small>{match.match_id}</small></div></div>
      <fieldset><legend>Indicatori manuali</legend>{annotationFlags.map(({ key, label, effect }) => { const descriptionId = `annotation-${key}-description`; return <label className="switch-row" key={key}><span><strong>{label}</strong><small id={descriptionId}>{effect}</small></span><input aria-label={label} aria-describedby={descriptionId} type="checkbox" checked={Boolean(values[key])} onChange={() => toggle(key)} /></label> })}</fieldset>
      <label>Etichetta manuale<input aria-label="Etichetta manuale" aria-describedby="annotation-label-description" value={values.manual_label} onChange={(event) => setValues((current) => ({ ...current, manual_label: event.target.value }))} maxLength={40} placeholder="es. scelta dei campioni sfavorevole" /><small id="annotation-label-description">Descrive la partita senza cambiare il peso automatico.</small></label>
      <label>Nota<textarea aria-label="Nota" aria-describedby="annotation-note-description" value={values.note} onChange={(event) => setValues((current) => ({ ...current, note: event.target.value }))} maxLength={1000} rows={5} placeholder="Contesto utile per la revisione futura…" /><small id="annotation-note-description">Contesto descrittivo per una revisione successiva.</small></label>
      <label>Quanto sei sicuro dell’annotazione · {pct(values.confidence * 100, 0)}<input aria-label="Sicurezza dell’annotazione" aria-describedby="annotation-confidence-description" type="range" min={0} max={1} step={0.05} value={values.confidence} onChange={(event) => setValues((current) => ({ ...current, confidence: Number(event.target.value) }))} /><small id="annotation-confidence-description">Valore solo descrittivo: non cambia il calcolo.</small></label>
      <div className="mutation-status" aria-live="polite">{mutation.isPending ? 'Salvataggio in corso…' : mutation.isError ? apiErrorLabel(mutation.error.message) : 'Le informazioni del modulo sostituiranno l’annotazione corrente.'}</div>
      <div className="dialog-actions"><button className="button button--ghost" type="button" onClick={() => onClose()}>Annulla</button><button className="button" type="submit" disabled={mutation.isPending}><Save aria-hidden="true" /> {mutation.isPending ? 'Salvo…' : 'Salva annotazione'}</button></div>
    </form>
  )
}

function AnnotationForm({ match, onClose, onDirtyChange }: { match: MatchDto; onClose: (saved?: boolean) => void; onDirtyChange: (dirty: boolean) => void }) {
  const annotation = useQuery(annotationQuery(match.match_id))
  if (annotation.isPending) return <Skeleton lines={5} label="Caricamento annotazione" />
  if (annotation.isError) return <ErrorState error={annotation.error} onRetry={() => void annotation.refetch()} />
  return <AnnotationEditor
    key={annotation.data.revision ?? 'new'}
    match={match}
    annotation={annotation.data.item}
    revision={annotation.data.revision}
    onClose={onClose}
    onDirtyChange={onDirtyChange}
  />
}

export function AuditPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const defaultFlag = embedded ? 'all' : 'contaminated'
  const flag = flags.some(([value]) => value === params.get('flag')) ? params.get('flag')! : defaultFlag
  const matches = useQuery({ ...matchesQuery(scope, flag), enabled: scopeReady })
  const [selected, setSelected] = useState<MatchDto | null>(null)
  const [annotationDirty, setAnnotationDirty] = useState(false)
  const closeAnnotation = (saved = false) => {
    if (!saved && annotationDirty && !window.confirm('Chiudere senza salvare le modifiche all’annotazione?')) return
    setAnnotationDirty(false)
    setSelected(null)
  }

  return (
    <div className="page-stack">
      <PageHeader level={embedded ? 2 : 1} eyebrow="Contesto / Partite da rivedere" title="Partite e annotazioni" copy={flag === 'all' ? 'Rivedi fino a 24 partite nei dati selezionati. Alcuni indicatori cambiano il peso automatico; etichette, note, grado di sicurezza e contesto restano descrittivi.' : 'Rivedi fino a 24 partite con l’indicatore selezionato. Solo le annotazioni di partita impossibile da vincere, giocatore inattivo (AFK) o giocatore che sabota cambiano il peso automatico di una sconfitta.'} aside={<StatusBadge tone="warning">{matches.data?.items.length ?? 0} / 24</StatusBadge>} />
      <FilterBar><label>Mostra<select value={flag} onChange={(event) => setParams((current) => {
        const next = new URLSearchParams(current)
        if (event.target.value === defaultFlag) next.delete('flag')
        else next.set('flag', event.target.value)
        return next
      }, { replace: true })}>{flags.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="filter-help"><ClipboardCheck aria-hidden="true" /> Apri una riga per annotarla</span><span className="filter-count" role="status">{matches.isFetching && !matches.isPending ? 'Aggiornamento risultati…' : `${matches.data?.items.length ?? 0} partite`}</span></FilterBar>
      {matches.isPending ? <Skeleton lines={9} label="Caricamento revisione partite" /> : null}
      {matches.isError ? <ErrorState error={matches.error} onRetry={() => void matches.refetch()} /> : null}
      {matches.data?.items.length ? <div className="audit-list" aria-busy={matches.isFetching && !matches.isPending}>{matches.data.items.map((match) => {
        const anomalyLabels = [
          match.explicit_afk || match.suspected_quasi_afk ? 'inattività (AFK)' : null,
          match.early_surrender ? 'resa anticipata' : null,
          match.annotation_manual_label ? `etichetta manuale ${match.annotation_manual_label}` : null,
          anomalyFlagsLabel(match.anomaly_flags) !== 'Nessuna anomalia' ? anomalyFlagsLabel(match.anomaly_flags) : null,
        ].filter(Boolean).join('; ') || 'nessuna anomalia descrittiva'
        const reason = technicalText(match.reason) || anomalyFlagsLabel(match.anomaly_flags) || 'Nessuna anomalia descrittiva.'
        const lossWeightLabel = match.win ? '' : ` Peso salvato della sconfitta ${Number(match.loss_attribution_weight).toFixed(2)}.`
        const accessibleLabel = `Apri annotazione: ${match.win ? 'vittoria' : 'sconfitta'} con ${match.champion}, ruolo ${roleLabel(match.role, true)}, account ${match.account}, ${queueLabel(match.queue)}, ${match.duration_minutes} minuti, ${formatDate(match.date)}. Qualità ${pct(match.match_quality_score * 100, 0)}.${lossWeightLabel} Anomalie: ${anomalyLabels}. Motivo: ${reason}.`
        return <article key={`${match.account}-${match.match_id}`}>
        <button type="button" onClick={() => { setAnnotationDirty(false); setSelected(match) }} aria-label={accessibleLabel}>
          <span className={match.win ? 'result-block result-block--win' : 'result-block result-block--loss'}>{match.win ? 'VITTORIA' : 'SCONFITTA'}</span>
          <ChampionAvatar name={match.champion} src={match.icon_url} />
          <div className="audit-identity"><strong>{match.champion}</strong><span>{roleLabel(match.role, true)} · {match.account}</span><small>{queueLabel(match.queue)} · {match.duration_minutes} min · {formatDate(match.date)}</small></div>
          <div className="audit-quality"><strong>{pct(match.match_quality_score * 100, 0)}</strong><span>qualità</span>{match.win ? null : <small>peso salvato della sconfitta {Number(match.loss_attribution_weight).toFixed(2)}</small>}</div>
          <div className="audit-flags">{match.explicit_afk || match.suspected_quasi_afk ? <StatusBadge tone="negative">Inattività (AFK)</StatusBadge> : null}{match.early_surrender ? <StatusBadge tone="warning">resa</StatusBadge> : null}{match.annotation_manual_label ? <StatusBadge tone="info">{match.annotation_manual_label}</StatusBadge> : null}</div>
          <p>{reason}</p>
        </button>
      </article>
      })}</div> : !matches.isPending && !matches.isError ? <EmptyState title={flag === 'all' ? 'Nessuna partita nei dati selezionati' : 'Nessun risultato per questo indicatore'} description="Modifica il filtro oppure cambia gli account considerati." /> : null}
      <Drawer open={Boolean(selected)} onOpenChange={(open) => !open && closeAnnotation()} title="Annotazione della partita" description="Il salvataggio conserva tutti i campi; solo gli indicatori con un effetto sul calcolo cambiano il peso automatico.">{selected ? <AnnotationForm key={`${selected.account}-${selected.match_id}`} match={selected} onClose={closeAnnotation} onDirtyChange={setAnnotationDirty} /> : null}</Drawer>
    </div>
  )
}
