import { useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Save, ScanSearch, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { ApiError, postJson, putJson, scopeQuery } from '../api/client'
import { algorithmSettingsQuery, queryKeys } from '../api/queries'
import type {
  AlgorithmPreviewResponseDto,
  AlgorithmSettingSchemaDto,
  AlgorithmSettings,
  AlgorithmSettingsResponseDto,
} from '../api/types'
import { getSetting, setSetting, useAlgorithmSettings } from '../app/algorithm-settings'
import { preferencePeriodLabel, queueLabel } from '../app/labels'
import { useScope } from '../app/scope'
import { useToast } from '../components/toast'
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, Surface } from '../components/ui'

interface EditorState { baseRevision: number; draft: AlgorithmSettings }

function cloneSettings(settings: AlgorithmSettings) {
  return structuredClone(settings)
}

function sameSettings(left: AlgorithmSettings, right: AlgorithmSettings) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function historicalSettingsDraft(settings: AlgorithmSettings, defaults: AlgorithmSettings) {
  let draft = cloneSettings(settings)
  if (getSetting(draft, 'recommendations') == null) {
    const recommendationDefaults = getSetting(defaults, 'recommendations')
    if (recommendationDefaults && typeof recommendationDefaults === 'object') draft = setSetting(draft, 'recommendations', structuredClone(recommendationDefaults))
  }
  return draft
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value ?? '—')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function names(value: unknown) {
  return list(value).map((item) => {
    const row = record(item)
    return String(row.champion ?? row.friend ?? row.id ?? '')
  }).filter(Boolean)
}

function countChangedRows(before: unknown, after: unknown) {
  const beforeMap = new Map(list(before).map((item) => {
    const row = record(item)
    return [String(row.id ?? row.champion ?? row.friend ?? ''), row]
  }))
  let estimates = 0
  let decisions = 0
  for (const item of list(after)) {
    const row = record(item)
    const old = beforeMap.get(String(row.id ?? row.champion ?? row.friend ?? ''))
    if (!old) { estimates += 1; decisions += row.actionable ? 1 : 0; continue }
    if (row.estimate !== old.estimate || row.score !== old.score) estimates += 1
    if (Boolean(row.actionable) !== Boolean(old.actionable)) decisions += 1
  }
  return { estimates, decisions }
}

function comparisonSummary(comparison: { algorithm: string; before: unknown; after: unknown }) {
  const before = record(comparison.before)
  const after = record(comparison.after)
  if (comparison.algorithm === 'Preferenze e prove personali') {
    const beforePlan = record(before.trial_plan)
    const afterPlan = record(after.trial_plan)
    return {
      rows: [
        ['Familiari e preferiti', list(before.known).length, list(after.known).length],
        ['Scoperte per affinità', list(before.discover).length, list(after.discover).length],
        ['Partite nel ciclo', beforePlan.budget ?? list(beforePlan.items).length, afterPlan.budget ?? list(afterPlan.items).length],
      ],
      beforeNames: [...names(before.known), ...names(before.discover)],
      afterNames: [...names(after.known), ...names(after.discover)],
    }
  }
  if (comparison.algorithm === 'Campioni e attribuzione') {
    const changes = countChangedRows(before.champions, after.champions)
    return {
      rows: [
        ['Consigli supportati', before.supported, after.supported],
        ['Stime cambiate', '—', changes.estimates],
        ['Decisioni cambiate', '—', changes.decisions],
      ],
      beforeNames: list(before.ranking).map(String),
      afterNames: list(after.ranking).map(String),
    }
  }
  if (comparison.algorithm === 'Piano di prove') {
    return {
      rows: [['Budget assegnato', before.budget_assigned ?? 0, after.budget_assigned ?? 0], ['Candidati', list(before.items).length, list(after.items).length]],
      beforeNames: names(before.items), afterNames: names(after.items),
    }
  }
  if (comparison.algorithm === 'Esplorazione') {
    return { rows: [['Suggerimenti', list(before.items).length, list(after.items).length]], beforeNames: names(before.items), afterNames: names(after.items) }
  }
  if (comparison.algorithm === 'Stili e comportamenti') {
    const beforeSummary = record(before.summary)
    const afterSummary = record(after.summary)
    return {
      rows: [['Categorie supportate', beforeSummary.supported_categories ?? 0, afterSummary.supported_categories ?? 0], ['Categorie analizzate', list(before.categories).length, list(after.categories).length], ['Metriche comportamentali', list(before.behavior).length, list(after.behavior).length]],
      beforeNames: names(before.categories), afterNames: names(after.categories),
    }
  }
  const changes = countChangedRows(before.items, after.items)
  return {
    rows: [['Elementi', list(before.items).length, list(after.items).length], ['Stime cambiate', '—', changes.estimates], ['Decisioni cambiate', '—', changes.decisions]],
    beforeNames: names(before.items), afterNames: names(after.items),
  }
}

function rankChanges(base: unknown, scenario: unknown) {
  const reference = list(base).map(String)
  const candidate = list(scenario).map(String)
  return candidate.filter((value, index) => reference[index] !== value).length
}

function maxEstimateDelta(base: unknown, scenario: unknown) {
  const reference = new Map(list(base).map((item) => {
    const row = record(item)
    return [String(row.id ?? ''), Number(row.estimate)]
  }))
  let maximum = 0
  for (const item of list(scenario)) {
    const row = record(item)
    const previous = reference.get(String(row.id ?? ''))
    const next = Number(row.estimate)
    if (typeof previous === 'number' && Number.isFinite(previous) && Number.isFinite(next)) maximum = Math.max(maximum, Math.abs(next - previous))
  }
  return maximum
}

function sensitivityWeights(label: string) {
  if (/pieni/i.test(label)) return '1 · 1 · 1 · 1 · 1 · 1'
  if (/storiche/i.test(label)) return '0 · 0,04 · 0,15 · 0,35 · 0,60 · 0,88'
  return 'Scenario alternativo'
}

function daysLabel(value: unknown) {
  return value === 'all' ? 'Tutto lo storico locale' : `${String(value)} giorni`
}

function periodLabel(value: unknown) {
  const label = preferencePeriodLabel(value)
  return label.charAt(0).toLocaleUpperCase('it') + label.slice(1)
}

function groupPresentation(group: string, fields: AlgorithmSettingSchemaDto[]) {
  if (fields.some((field) => field.path.startsWith('recommendations.'))) return {
    name: 'Raccomandazioni attuali',
    description: 'Gusti osservati, risultati reali, affinità di catalogo e ciclo breve di prove. Non usa prior e non richiede 20 partite.',
  }
  if (fields.some((field) => field.path.startsWith('evidence.'))) return {
    name: 'Analisi statistiche precedenti · Evidenza',
    description: 'Parametri conservati per confronti, audit e viste statistiche precedenti; non decidono l’ordine del nuovo motore di raccomandazione.',
  }
  if (fields.some((field) => field.path.startsWith('context.'))) return {
    name: 'Contesto analisi precedenti',
    description: 'Coda e periodo predefiniti per le viste statistiche precedenti; il motore di raccomandazione usa il proprio contesto.',
  }
  return { name: group, description: `${fields.length} parametri configurabili` }
}

function normalizeOption(option: NonNullable<AlgorithmSettingSchemaDto['options']>[number]) {
  return typeof option === 'object' ? option : { label: String(option), value: option }
}

export function settingOptionLabel(path: string, value: string | number, fallback: string) {
  if (path === 'context.queue') return queueLabel(value)
  if (path === 'context.days') return value === 'all' ? 'Tutto lo storico' : `${value} giorni`
  if (path === 'recommendations.queue') {
    if (value === 'all') return 'Tutte le code'
    return value === 'auto' ? 'Automatica · più giocata nel perimetro' : queueLabel(value)
  }
  return fallback
}

export function SettingControl({ field, value, onChange, resetKey = 0 }: {
  field: AlgorithmSettingSchemaDto
  value: unknown
  onChange: (value: unknown) => void
  resetKey?: number
}) {
  const id = `algorithm-${field.path.replace(/[^a-z0-9]+/gi, '-')}`
  const descriptionId = `${id}-description`
  const options = field.options?.map(normalizeOption) ?? []
  if (field.type === 'boolean') {
    return <label className="algorithm-setting algorithm-setting--toggle" htmlFor={id}>
      <span><strong>{field.label}</strong><small id={descriptionId}>{field.description}</small></span>
      <input id={id} aria-label={field.label} aria-describedby={descriptionId} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
    </label>
  }
  if (field.type === 'period') {
    return <PeriodSettingControl key={resetKey} id={id} descriptionId={descriptionId} field={field} value={value} onChange={onChange} />
  }
  if (field.type === 'select' || options.length) {
    return <label className="algorithm-setting" htmlFor={id}>
      <span><strong>{field.label}</strong><small id={descriptionId}>{field.description}</small></span>
      <select id={id} aria-describedby={descriptionId} value={String(value ?? '')} onChange={(event) => {
        const selected = options.find((item) => String(item.value) === event.target.value)
        onChange(selected?.value ?? event.target.value)
      }}>{options.map((option) => <option key={String(option.value)} value={String(option.value)}>{settingOptionLabel(field.path, option.value, option.label)}</option>)}</select>
    </label>
  }
  if (field.type.endsWith('[]') || Array.isArray(value)) {
    return <ArraySettingControl key={formatValue(value)} id={id} descriptionId={descriptionId} field={field} value={value} onChange={onChange} />
  }
  const numeric = field.type === 'number' || field.type === 'integer' || typeof value === 'number'
  return <label className="algorithm-setting" htmlFor={id}>
    <span><strong>{field.label}</strong><small id={descriptionId}>{field.description}</small></span>
    <input
      id={id}
      aria-label={field.label}
      aria-describedby={descriptionId}
      type={numeric ? 'number' : 'text'}
      min={field.min}
      max={field.max}
      step={field.type === 'integer' ? 1 : numeric ? 'any' : undefined}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      onChange={(event) => onChange(numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
    />
  </label>
}

function PeriodSettingControl({ id, descriptionId, field, value, onChange }: {
  id: string
  descriptionId: string
  field: AlgorithmSettingSchemaDto
  value: unknown
  onChange: (value: unknown) => void
}) {
  const period = record(value)
  const currentValue = typeof period.value === 'number' && Number.isSafeInteger(period.value) ? period.value : 0
  const currentUnit = period.unit === 'games' ? 'games' : 'days'
  const source = `${id}\u0000${currentValue}\u0000${currentUnit}`
  const [edit, setEdit] = useState({ source, draft: String(currentValue), invalid: false })
  const draft = edit.source === source ? edit.draft : String(currentValue)
  const invalid = edit.source === source ? edit.invalid : false
  const errorId = `${id}-error`
  const updateEdit = (nextDraft: string, nextInvalid = false) => {
    setEdit({ source, draft: nextDraft, invalid: nextInvalid })
  }
  const parseDraft = () => {
    const parsed = Number(draft)
    return draft.trim() !== '' && Number.isSafeInteger(parsed) && parsed >= (field.min ?? 0) && parsed <= (field.max ?? 100000)
      ? parsed
      : null
  }
  const commit = () => {
    const parsed = parseDraft()
    if (parsed == null) { updateEdit(draft, true); return }
    updateEdit(draft)
    onChange({ value: parsed, unit: currentUnit })
  }
  return <label className="algorithm-setting" htmlFor={id}>
    <span><strong>{field.label}</strong><small id={descriptionId}>{field.description}</small></span>
    <div className="algorithm-period-control">
      <input
        id={id}
        aria-label={field.label}
        aria-describedby={`${descriptionId}${invalid ? ` ${errorId}` : ''}`}
        aria-invalid={invalid}
        type="number"
        min={field.min}
        max={field.max}
        step={1}
        value={draft}
        onChange={(event) => {
          const nextDraft = event.target.value
          const parsed = Number(nextDraft)
          updateEdit(nextDraft)
          if (nextDraft.trim() !== '' && Number.isSafeInteger(parsed) && parsed >= (field.min ?? 0) && parsed <= (field.max ?? 100000)) {
            onChange({ value: parsed, unit: currentUnit })
          }
        }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
      />
      <select
        aria-label="Unità del periodo"
        aria-describedby={descriptionId}
        value={currentUnit}
        onChange={(event) => {
          const parsed = parseDraft()
          if (parsed == null) { updateEdit(draft, true); return }
          const unit = event.target.value === 'games' ? 'games' : 'days'
          updateEdit(String(parsed))
          onChange({ value: parsed, unit })
        }}
      >
        {(field.options ?? ['days', 'games']).map((rawOption) => {
          const option = normalizeOption(rawOption)
          const unit = String(option.value)
          return <option key={unit} value={unit}>{unit === 'games' ? 'Partite' : 'Giorni'}</option>
        })}
      </select>
    </div>
    {invalid ? <small className="field-error" id={errorId}>Inserisci 0 oppure un intero positivo fino a {field.max ?? 100000}.</small> : null}
  </label>
}

function ArraySettingControl({ id, descriptionId, field, value, onChange }: {
  id: string
  descriptionId: string
  field: AlgorithmSettingSchemaDto
  value: unknown
  onChange: (value: unknown) => void
}) {
  const formatted = formatValue(value)
  const [draft, setDraft] = useState(formatted)
  const [invalid, setInvalid] = useState(false)
  const commit = () => {
    const parts = draft.split(',').map((item) => item.trim()).filter(Boolean)
    if (field.type === 'number[]') {
      const parsed = parts.map(Number)
      if (!parts.length || parsed.some((item) => !Number.isFinite(item))) {
        setInvalid(true)
        return
      }
      setInvalid(false)
      onChange(parsed)
      return
    }
    setInvalid(false)
    onChange(parts)
  }
  const errorId = `${id}-error`
  return <label className="algorithm-setting" htmlFor={id}>
    <span><strong>{field.label}</strong><small id={descriptionId}>{field.description}</small></span>
    <input
      id={id}
      aria-label={field.label}
      aria-describedby={`${descriptionId}${invalid ? ` ${errorId}` : ''}`}
      aria-invalid={invalid}
      value={draft}
      inputMode={field.type === 'number[]' ? 'decimal' : undefined}
      onChange={(event) => { setDraft(event.target.value); setInvalid(false) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
    />
    {invalid ? <small className="field-error" id={errorId}>Inserisci uno o più numeri separati da virgole.</small> : null}
  </label>
}

export function AlgorithmSettingsPage() {
  const active = useAlgorithmSettings()
  const { scope } = useScope()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [editorState, setEditor] = useState<EditorState | null>(null)
  const [controlResetKey, setControlResetKey] = useState(0)
  const [preview, setPreview] = useState<AlgorithmPreviewResponseDto | null>(null)
  const [previewError, setPreviewError] = useState<Error | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const previewController = useRef<AbortController | null>(null)

  useEffect(() => () => previewController.current?.abort(), [])

  const editor = editorState ?? (active.data
    ? { baseRevision: active.data.revision, draft: cloneSettings(active.data.settings) }
    : null)
  const dirty = Boolean(editor && active.data && !sameSettings(editor.draft, active.data.settings))
  const blocker = useBlocker(dirty)

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm('Hai una bozza di impostazioni non applicata. Vuoi uscire e scartarla?')) blocker.proceed()
    else blocker.reset()
  }, [blocker])

  useEffect(() => {
    if (!dirty) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirty])

  const groups = useMemo(() => {
    const result = new Map<string, AlgorithmSettingSchemaDto[]>()
    for (const field of active.data?.schema ?? []) {
      const entries = result.get(field.group) ?? []
      entries.push(field)
      result.set(field.group, entries)
    }
    return [...result.entries()].sort(([, left], [, right]) => {
      const leftPriority = left.some((field) => field.path.startsWith('recommendations.')) ? 0 : 1
      const rightPriority = right.some((field) => field.path.startsWith('recommendations.')) ? 0 : 1
      return leftPriority - rightPriority
    })
  }, [active.data?.schema])

  if (active.isPending || !editor) return <div className="page-stack"><Skeleton lines={10} label="Caricamento delle impostazioni algoritmiche" /></div>
  if (active.error || !active.data) return <ErrorState title="Impossibile caricare le impostazioni algoritmiche" error={active.error ?? new Error('Risposta delle impostazioni non disponibile.')} onRetry={() => { void active.refetch() }} />

  const previewChampionBase = record(preview?.comparisons.find((item) => item.algorithm === 'Campioni e attribuzione')?.after)
  const negativeVeto = Boolean(getSetting(active.data.settings, 'attribution.negative_veto'))
  const setValue = (path: string, value: unknown) => {
    setEditor({ ...editor, draft: setSetting(editor.draft, path, value) })
    setPreview(null)
    setPreviewError(null)
  }
  const previewSettings = async () => {
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    setPreviewing(true)
    setPreviewError(null)
    try {
      const scoped = scopeQuery(scope)
      const result = await postJson<AlgorithmPreviewResponseDto>('/api/algorithm-settings/preview', {
        expected_revision: editor.baseRevision,
        settings: editor.draft,
        scope: {
          account: scoped.account ?? [],
          companion_account: scoped.companion_account ?? [],
          companion_mode: scoped.companion_mode ?? null,
        },
        filters: {},
      }, controller.signal)
      setPreview(result)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (error instanceof ApiError && error.status === 409) {
        try {
          const fresh = await queryClient.fetchQuery({ ...algorithmSettingsQuery, staleTime: 0 })
          setEditor({ ...editor, baseRevision: fresh.revision })
          setPreviewError(new Error('La revisione attiva è cambiata. La bozza è conservata: ricalcola l’anteprima sulla nuova base.'))
          return
        } catch {
          // Preserve the original conflict below when the refresh also fails.
        }
      }
      setPreviewError(error instanceof Error ? error : new Error('Anteprima non disponibile.'))
    } finally {
      if (previewController.current === controller) {
        previewController.current = null
        setPreviewing(false)
      }
    }
  }
  const applySettings = async () => {
    previewController.current?.abort()
    setPreviewing(false)
    setApplying(true)
    try {
      await queryClient.cancelQueries({ predicate: (query) => query.queryKey[0] === 'api' && query.queryKey[1] !== 'algorithm-settings' })
      const saved = await putJson<AlgorithmSettingsResponseDto>('/api/algorithm-settings', {
        expected_revision: editor.baseRevision,
        settings: editor.draft,
      })
      queryClient.setQueryData(queryKeys.algorithmSettings, saved)
      setEditor({ baseRevision: saved.revision, draft: cloneSettings(saved.settings) })
      setControlResetKey((current) => current + 1)
      setPreview(null)
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'api' && query.queryKey[1] !== 'algorithm-settings' })
      notify('Impostazioni applicate', { description: `Revisione ${saved.revision}. I risultati vengono ricalcolati dal server.`, tone: 'success' })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const fresh = await queryClient.fetchQuery({ ...algorithmSettingsQuery, staleTime: 0 })
          setEditor((current) => ({ ...(current ?? editor), baseRevision: fresh.revision }))
          notify('Le impostazioni attive sono cambiate', { description: 'Ho ricaricato la revisione corrente e conservato la tua bozza. Controlla l’anteprima prima di riprovare.', tone: 'error' })
        } catch {
          notify('Conflitto di revisione', { description: 'La tua bozza è conservata, ma non è stato possibile ricaricare la revisione attiva.', tone: 'error' })
        }
      } else {
        notify('Impossibile applicare le impostazioni', { description: error instanceof Error ? error.message : undefined, tone: 'error' })
      }
    } finally {
      setApplying(false)
    }
  }

  return <div className="page-stack algorithm-settings-page">
    <PageHeader eyebrow="Impostazioni / Algoritmi" title="Parametri degli algoritmi" copy="Configura il motore di raccomandazione basato su gusti e risultati e le analisi statistiche precedenti. La bozza resta locale finché non la applichi." aside={<StatusBadge tone={dirty ? 'warning' : 'positive'}>{dirty ? 'Bozza non applicata' : `Revisione ${active.data.revision}`}</StatusBadge>} />

    <section className="algorithm-settings-summary" aria-label="Stato delle impostazioni">
      <Surface><span>Revisione attiva</span><strong>{active.data.revision}</strong><small>{active.data.fingerprint}</small></Surface>
      <Surface><span>Contesto globale</span><strong>{queueLabel(String(getSetting(active.data.settings, 'context.queue')))}</strong><small>{daysLabel(getSetting(active.data.settings, 'context.days'))} · usato come default esplicito</small></Surface>
      <Surface><span>Motore di raccomandazione</span><strong>Gusti + risultati</strong><small>{settingOptionLabel('recommendations.queue', String(getSetting(active.data.settings, 'recommendations.queue') ?? 'all'), 'Tutte le code')} · {periodLabel(getSetting(active.data.settings, 'recommendations.period'))}. Nessun prior e nessun minimo obbligatorio di 20 partite.</small></Surface>
      <Surface><span>Analisi statistiche precedenti</span><strong>Esiti reali</strong><small>Vittorie e sconfitte vengono contate per intero nelle stime. I pesi modificano l’attribuzione nell’audit. {negativeVeto ? 'Il veto negativo attivo può bloccare conclusioni operative di quelle analisi, senza cambiare la stima.' : 'Se attivato, il veto negativo può bloccare conclusioni operative di quelle analisi senza cambiare la stima.'}</small></Surface>
    </section>

    {groups.length ? groups.map(([group, fields]) => { const presentation = groupPresentation(group, fields); return <details key={group} className="surface algorithm-settings-group" open={fields.some((field) => field.path.startsWith('recommendations.'))}>
      <summary><SlidersHorizontal aria-hidden="true" /><span><strong>{presentation.name}</strong><small>{presentation.description}</small></span></summary>
      <div className="algorithm-settings-grid">{fields.map((field) => <SettingControl key={field.path} resetKey={controlResetKey} field={field} value={getSetting(editor.draft, field.path)} onChange={(value) => setValue(field.path, value)} />)}</div>
    </details> }) : <EmptyState title="Schema dei parametri non disponibile" description="Il server non ha restituito controlli modificabili per questa revisione." />}

    <div className="algorithm-settings-actions">
      <button className="button button--secondary" type="button" disabled={!dirty || applying || previewing} onClick={() => { setEditor({ baseRevision: active.data!.revision, draft: cloneSettings(active.data!.settings) }); setControlResetKey((current) => current + 1); setPreview(null) }}><RotateCcw aria-hidden="true" /> Ripristina attive</button>
      <button className="button button--secondary" type="button" disabled={applying || previewing} onClick={() => { setEditor({ baseRevision: active.data!.revision, draft: cloneSettings(active.data!.defaults) }); setControlResetKey((current) => current + 1); setPreview(null) }}><RotateCcw aria-hidden="true" /> Ripristina consigliate</button>
      <button className="button button--secondary" type="button" disabled={!dirty || applying || previewing} onClick={() => void previewSettings()}><ScanSearch aria-hidden="true" /> {previewing ? 'Calcolo anteprima…' : 'Calcola anteprima'}</button>
      <button className="button" type="button" disabled={!dirty || applying || previewing} onClick={() => void applySettings()}><Save aria-hidden="true" /> {applying ? 'Applicazione…' : 'Applica impostazioni'}</button>
    </div>

    {previewError ? <ErrorState title="Impossibile calcolare l’anteprima" error={previewError} onRetry={() => void previewSettings()} /> : null}
    {preview ? <Surface className="algorithm-preview">
      <header><div><p className="eyebrow">Anteprima isolata</p><h2>{preview.changed_paths.length} parametri con impatto</h2></div><StatusBadge tone="info">Base revisione {preview.base_revision}</StatusBadge></header>
      <p className="section-copy">Fingerprint proposto: <code>{preview.proposed_fingerprint}</code>. Nessuna impostazione è stata applicata.</p>
      <div className="algorithm-preview-paths">{preview.changed_paths.map((path) => <code key={path}>{path}</code>)}</div>
      {preview.comparisons.length ? <div className="algorithm-comparisons">{preview.comparisons.map((comparison) => {
        const summary = comparisonSummary(comparison)
        return <article key={comparison.algorithm}><h3>{comparison.algorithm}</h3>
          <table className="algorithm-comparison-table" aria-label={`Confronto ${comparison.algorithm}`}><thead><tr><th>Indicatore</th><th>Prima</th><th>Dopo</th></tr></thead><tbody>
            {summary.rows.map(([label, before, after]) => <tr key={String(label)}><th scope="row">{formatValue(label)}</th><td>{formatValue(before)}</td><td>{formatValue(after)}</td></tr>)}
          </tbody></table>
          {summary.beforeNames.length || summary.afterNames.length ? <p><strong>Prima:</strong> {summary.beforeNames.join(' · ') || 'nessun nome'}<br /><strong>Dopo:</strong> {summary.afterNames.join(' · ') || 'nessun nome'}</p> : null}
          <details className="algorithm-preview-details"><summary>Dettagli tecnici</summary><pre>{JSON.stringify({ before: comparison.before, after: comparison.after }, null, 2)}</pre></details>
        </article>
      })}</div> : null}
      {preview.sensitivity.length ? <details className="algorithm-preview-details" open><summary>Controlli di sensibilità · {preview.sensitivity.length}</summary>
        <div className="data-table-wrap"><table aria-label="Scenari di sensibilità"><thead><tr><th>Scenario</th><th>Pesi audit precedente</th><th>Familiari e preferiti</th><th>Scoperte</th><th>Prove</th><th>Posizioni cambiate · analisi precedente</th><th>Massima variazione · analisi precedente</th></tr></thead><tbody>{preview.sensitivity.map((scenario, index) => {
          const row = record(scenario)
          const preferences = record(row.preferences)
          const trialPlan = record(preferences.trial_plan)
          return <tr key={`${String(row.label)}-${index}`}><th scope="row">{String(row.label ?? `Scenario ${index + 1}`)}</th><td>{sensitivityWeights(String(row.label ?? ''))}</td><td>{list(preferences.known).length}</td><td>{list(preferences.discover).length}</td><td>{list(trialPlan.items).length}</td><td>{rankChanges(previewChampionBase.ranking, row.ranking)}</td><td>{maxEstimateDelta(previewChampionBase.champions, row.champions).toLocaleString('it-IT', { maximumFractionDigits: 2 })} pp</td></tr>
        })}</tbody></table></div>
        <details className="algorithm-preview-details"><summary>Dati tecnici degli scenari</summary><pre>{JSON.stringify(preview.sensitivity, null, 2)}</pre></details>
      </details> : null}
      <details className="algorithm-preview-details"><summary>Contesto effettivo dell’anteprima</summary><pre>{JSON.stringify(preview.context, null, 2)}</pre></details>
      {preview.notes.length ? <ul>{preview.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
    </Surface> : null}

    {active.data.history.length ? <Surface><div className="section-heading"><div><p className="eyebrow">Cronologia</p><h2>Revisioni recenti</h2></div></div><p className="section-copy">Carica una revisione compatibile nella bozza, controlla l’anteprima e applicala: verrà salvata come nuova revisione.</p><div className="algorithm-history">{active.data.history.map((item, index) => {
      const restorable = item.revision !== 1 && item.settings && typeof item.settings === 'object' && !Array.isArray(item.settings)
      return <article key={`${item.revision ?? 'entry'}-${index}`}><strong>Revisione {item.revision ?? '—'}</strong><span>{item.revision === 1 ? 'Storico legacy · sola lettura' : item.summary ?? item.fingerprint ?? 'Modifica registrata'}</span><small>{item.created_at ?? ''}</small><button className="button button--ghost button--compact" type="button" disabled={!restorable || applying || previewing} onClick={() => {
        if (!restorable) return
        const historicalDraft = historicalSettingsDraft(item.settings!, active.data!.defaults)
        setEditor({ baseRevision: active.data!.revision, draft: historicalDraft })
        setPreview(null)
        setPreviewError(null)
      }}>{item.revision === 1 ? 'Solo lettura' : 'Carica in bozza'}</button></article>
    })}</div></Surface> : null}
  </div>
}
