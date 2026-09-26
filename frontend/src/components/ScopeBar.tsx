import { ChevronDown, SlidersHorizontal, UsersRound } from 'lucide-react'
import { Link } from 'react-router'
import { useScope } from '../app/scope'
import { useGlassReflection } from '../app/surface-motion'
import { AppearanceSettings } from './AppearanceSettings'
import { DataViewSettings } from './DataViewSettings'
import { StatusBadge } from './ui'
import './ScopeBar.css'

const integer = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 })

export function ScopeBar() {
  const glassRef = useGlassReflection()
  const { state, scope, availableAccounts, accountsLoading, accountsError, scopeReady, retryAccounts } = useScope()
  const allSelected = availableAccounts.length > 0 && state.accounts.length === availableAccounts.length
  const coverage = availableAccounts
    .filter((item) => scope.accounts.includes(item.account))
    .reduce((totals, item) => ({
      raw: totals.raw + (item.raw_games ?? item.games),
      eligible: totals.eligible + (item.eligible_games ?? item.games),
      analyzed: totals.analyzed + item.analyzed_games,
    }), { raw: 0, eligible: 0, analyzed: 0 })
  const label = accountsLoading
    ? 'Verifica degli account'
    : accountsError && !scopeReady
      ? 'Account non verificati'
      : allSelected
        ? `Tutti gli account · ${state.accounts.length}`
        : `${state.accounts.length} account attivi`

  return (
    <section ref={glassRef} className="scope-bar" aria-label="Dati usati per le risposte">
      <div className="scope-bar__identity">
        <span className="scope-bar__icon"><UsersRound aria-hidden="true" /></span>
        <div>
          <p>Dati usati</p>
          <strong>{label}</strong>
          {!state.companion ? <small>Nessun filtro sui compagni</small> : null}
          {scopeReady ? (
            <details className="scope-bar__coverage">
              <summary>Copertura tecnica</summary>
              <span>{integer.format(coverage.raw)} raccolte · {integer.format(coverage.eligible)} ammesse · {integer.format(coverage.analyzed)} analizzate</span>
            </details>
          ) : null}
        </div>
      </div>
      <div className="scope-bar__status" data-active={Boolean(state.companion || (accountsError && !scopeReady))}>
        {state.companion ? <StatusBadge tone="warning">{state.companion.mode === 'exclude' ? 'Escludi' : 'Solo con'} · {state.companion.name}</StatusBadge> : null}
        {accountsError && !scopeReady ? <StatusBadge tone="negative">Account non disponibili</StatusBadge> : null}
      </div>
      {accountsError && !scopeReady ? <button className="button button--ghost button--compact" type="button" onClick={retryAccounts}>Riprova</button> : null}
      <Link className="button button--secondary scope-bar__change" to="/app/profile">
        <SlidersHorizontal aria-hidden="true" /> <span className="scope-bar__change-full">Apri Dati usati</span><span className="scope-bar__change-short">Dati</span>
      </Link>
      <details className="scope-bar__display-controls">
        <summary>Visualizzazione <ChevronDown aria-hidden="true" /></summary>
        <div>
          <DataViewSettings />
          <AppearanceSettings compact />
        </div>
      </details>
    </section>
  )
}
