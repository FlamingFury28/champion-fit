import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  History,
  LayoutDashboard,
  Map as MapIcon,
  Menu,
  RefreshCw,
  Swords,
  UsersRound,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { syncStatusQuery } from '../api/queries'
import type { SyncStatusResponseDto } from '../api/types'
import { destinations } from '../app/navigation'
import { queryClient } from '../app/query-client'
import { ScopeProvider, useScope } from '../app/scope'
import { AlgorithmSettingsProvider, useAlgorithmSettings } from '../app/algorithm-settings'
import { useContentMotion } from '../app/surface-motion'
import { AppToastProvider } from './toast'
import { BrandMark } from './BrandMark'
import { Drawer, EmptyState, ErrorState, Skeleton, StatusBadge } from './ui'
import { ScopeBar } from './ScopeBar'

interface NavItem { label: string; to: string; icon: LucideIcon }
interface NavGroup { label?: string; variant?: 'questions'; items: NavItem[] }

const navGroups: NavGroup[] = [
  { items: [
    { label: 'Riepilogo', to: destinations.overview, icon: LayoutDashboard },
    { label: 'Campioni', to: destinations.champions, icon: Swords },
    { label: 'Le mie partite', to: destinations.matches, icon: History },
  ] },
  { label: 'Strumenti', items: [
    { label: 'Compagni', to: destinations.companions, icon: UsersRound },
    { label: 'Algoritmi', to: destinations.algorithmSettings, icon: Settings2 },
  ] },
]

function Brand() {
  return (
    <NavLink className="brand" to="/app/overview" aria-label="Champion Fit, riepilogo">
      <BrandMark className="brand__mark" />
      <span>CHAMPION FIT</span>
    </NavLink>
  )
}

function SiteMapLink() {
  return <NavLink className="site-map-trigger" to={destinations.siteMap} aria-label="Mappa del sito" title="Mappa del sito">
    <MapIcon aria-hidden="true" />
    <span>Mappa</span>
  </NavLink>
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="app-nav" aria-label="Navigazione principale">
      {navGroups.map((group, groupIndex) => (
        <section key={group.label ?? groupIndex} data-variant={group.variant}>
          {group.label ? <p>{group.label}</p> : null}
          {group.items.map((item) => {
            const Icon = item.icon
            return (
              <NavLink key={item.to} to={item.to} onClick={onNavigate}>
                <Icon aria-hidden />
                <span>{item.label}</span>
              </NavLink>
            )
          })}
        </section>
      ))}
    </nav>
  )
}

export function importCompletedBetween(previous: SyncStatusResponseDto, current: SyncStatusResponseDto) {
  if (current.mode !== 'snapshot') return false
  if (current.last_completed_at && current.last_completed_at !== previous.last_completed_at) return true
  return previous.mode === 'importing'
}

export function isImportRefreshDependency(queryKey: readonly unknown[]) {
  return queryKey[0] === 'api' && queryKey[1] !== 'sync-status' && queryKey[1] !== 'algorithm-settings'
}

export function pageTitleForLocation(pathname: string, search: string) {
  const page = navGroups.flatMap((group) => group.items)
    .find((item) => pathname === item.to || (item.to === destinations.champions && pathname.startsWith(`${destinations.champions}/`)))
  const detail = pathname === destinations.champions ? new URLSearchParams(search).get('detail') : null
  if (detail) return `${detail} · Campioni · Champion Fit`
  if (page) return `${page.label} · Champion Fit`
  if (pathname === destinations.siteMap) return 'Mappa del sito · Champion Fit'
  if (pathname === destinations.data) return 'Dati usati · Champion Fit'
  return 'Pagina non trovata · Champion Fit'
}

export function isKnownApplicationPath(pathname: string) {
  if (pathname === '/app') return true
  if (Object.values(destinations).includes(pathname as typeof destinations[keyof typeof destinations])) return true
  if (pathname.startsWith('/app/champions/')) return true
  return ['/app/playstyles', '/app/team/synergy', '/app/test-plan', '/app/review/audit', '/app/review/blacklist', '/app/scout'].includes(pathname)
}

export function ScopedOutlet() {
  const location = useLocation()
  const { accountsLoading, accountsError, scopeEmpty, scopeReady, retryAccounts, algorithmSettingsLoading, algorithmSettingsError } = useScope()
  const { refetch: retryAlgorithmSettings, refreshError, isFetching: refreshingSettings } = useAlgorithmSettings()

  if (!isKnownApplicationPath(location.pathname)) return <Outlet />
  if (location.pathname.startsWith(destinations.algorithmSettings) || location.pathname === destinations.siteMap) return <Outlet />
  if (algorithmSettingsLoading) {
    return <div className="page-stack" aria-busy="true"><Skeleton lines={8} label="Caricamento delle impostazioni algoritmiche" /></div>
  }
  if (algorithmSettingsError) {
    return <ErrorState title="Impossibile caricare le impostazioni algoritmiche" error={algorithmSettingsError} onRetry={() => { void retryAlgorithmSettings() }} />
  }

  if (accountsLoading) {
    return <div className="page-stack" aria-busy="true"><Skeleton lines={8} label="Verifica degli account" /></div>
  }
  if (accountsError && !scopeReady) {
    return (
      <ErrorState
        title="Impossibile verificare gli account"
        error={accountsError}
        onRetry={retryAccounts}
      />
    )
  }
  if (scopeEmpty || !scopeReady) {
    return (
      <EmptyState
        title="Nessun account disponibile"
        description="Esegui l’importazione Riot dal processo server, poi aggiorna l’elenco degli account."
        action={<button className="button button--secondary" type="button" onClick={retryAccounts}><RefreshCw aria-hidden="true" /> Aggiorna account</button>}
      />
    )
  }
  return <>
    {refreshError ? <div className="scope-refresh-banner scope-refresh-banner--action" role="status">
      <RefreshCw aria-hidden="true" />
      <span>Non riesco ad aggiornare la configurazione. Uso l’ultima configurazione disponibile e conservo le modifiche in corso.</span>
      <button className="button button--secondary button--compact" type="button" disabled={refreshingSettings} onClick={() => { void retryAlgorithmSettings() }}>{refreshingSettings ? 'Riprovo…' : 'Riprova aggiornamento'}</button>
    </div> : null}
    <Outlet />
  </>
}

function AppChrome() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const mainContent = useRef<HTMLElement>(null)
  const previousPath = useRef<string | null>(null)
  const previousSync = useRef<SyncStatusResponseDto | undefined>(undefined)
  const sync = useQuery(syncStatusQuery)
  const location = useLocation()
  const routeMotion = useContentMotion(location.pathname)

  useEffect(() => {
    document.title = pageTitleForLocation(location.pathname, location.search)

    if (previousPath.current === null) {
      previousPath.current = location.pathname
      return
    }
    if (previousPath.current === location.pathname) return
    previousPath.current = location.pathname
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    window.requestAnimationFrame(() => mainContent.current?.focus({ preventScroll: true }))
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!sync.data) return
    const previous = previousSync.current
    previousSync.current = sync.data
    if (!previous || !importCompletedBetween(previous, sync.data)) return
    void queryClient.invalidateQueries({
      predicate: (query) => isImportRefreshDependency(query.queryKey),
    })
  }, [sync.data])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Vai al contenuto</a>
      <header className="app-topbar">
        <Brand />
        <Navigation />
        <SiteMapLink />
        <button className="mobile-menu-button" type="button" aria-label="Apri il menu" onClick={() => setMobileNavOpen(true)}>
          <Menu aria-hidden="true" />
          <span>Menu</span>
        </button>
        <ScopeBar />
      </header>
      <Drawer open={mobileNavOpen} onOpenChange={setMobileNavOpen} title="Esplora Champion Fit">
        <Navigation onNavigate={() => setMobileNavOpen(false)} />
      </Drawer>
      <div className="app-content">
        <main ref={mainContent} id="main-content" tabIndex={-1}>
          {sync.data?.sync_active || sync.data?.mode === 'importing' ? (
            <div className="sync-banner" role="status">
              Importazione in corso: i dati possono aggiornarsi mentre navighi.
              <StatusBadge tone="positive">in aggiornamento</StatusBadge>
            </div>
          ) : null}
          <div className="route-content" ref={routeMotion}><ScopedOutlet /></div>
        </main>
      </div>
    </div>
  )
}

export function AppShell() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppToastProvider>
        <AlgorithmSettingsProvider><ScopeProvider><AppChrome /></ScopeProvider></AlgorithmSettingsProvider>
      </AppToastProvider>
    </QueryClientProvider>
  )
}
