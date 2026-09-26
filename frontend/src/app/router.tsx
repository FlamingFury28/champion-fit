import { useEffect } from 'react'
import { Navigate, createBrowserRouter, isRouteErrorResponse, useLocation, useRouteError } from 'react-router'
import { ErrorState } from '../components/ui'
import { LandingPage } from '../pages/LandingPage'
import { legacyDestination, legacyPagePaths } from './navigation'

function LegacyRoute() {
  const location = useLocation()
  return <Navigate to={`${legacyDestination(location.pathname, location.search) ?? '/app/overview'}${location.hash}`} replace />
}

function routeError(error: unknown) {
  if (error instanceof Error) return error
  if (isRouteErrorResponse(error)) return new Error(error.statusText || `Errore ${error.status}`)
  return new Error('La pagina non è stata caricata correttamente.')
}

export function RouteErrorBoundary() {
  const error = routeError(useRouteError())
  useEffect(() => { document.title = 'Errore di caricamento · Champion Fit' }, [])
  return <main className="page-stack"><ErrorState title="Impossibile caricare la pagina" error={error} onRetry={() => window.location.reload()} /></main>
}

export async function notFoundRoute() {
  const { NotFoundPage } = await import('../pages/NotFoundPage')
  return {
    Component: function NotFoundRoute() {
      useEffect(() => { document.title = 'Pagina non trovata · Champion Fit' }, [])
      return <NotFoundPage />
    },
  }
}

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage />, errorElement: <RouteErrorBoundary /> },
  ...legacyPagePaths.map((path) => ({
    path,
    element: <LegacyRoute />,
    errorElement: <RouteErrorBoundary />,
  })),
  {
    path: '/app',
    lazy: async () => ({ Component: (await import('../components/AppShell')).AppShell }),
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: 'overview', lazy: async () => ({ Component: (await import('../pages/OverviewPage')).OverviewPage }) },
      { path: 'map', lazy: async () => ({ Component: (await import('../pages/SiteMapPage')).SiteMapPage }) },
      { path: 'profile', lazy: async () => ({ Component: (await import('../pages/ProfilePage')).ProfilePage }) },
      { path: 'settings/algorithms', lazy: async () => ({ Component: (await import('../pages/AlgorithmSettingsPage')).AlgorithmSettingsPage }) },
      { path: 'matches', lazy: async () => ({ Component: (await import('../pages/MatchesPage')).MatchesPage }) },
      { path: 'playstyles', element: <LegacyRoute /> },
      { path: 'team/friends', lazy: async () => ({ Component: (await import('../pages/FriendsPage')).FriendsPage }) },
      { path: 'team/synergy', element: <LegacyRoute /> },
      { path: 'fit', lazy: async () => ({ Component: (await import('../pages/ChampionsHubPage')).ChampionsHubPage }) },
      { path: 'champions', element: <LegacyRoute /> },
      { path: 'champions/:champion', element: <LegacyRoute /> },
      { path: 'test-plan', element: <LegacyRoute /> },
      { path: 'review/audit', element: <LegacyRoute /> },
      { path: 'review/blacklist', element: <LegacyRoute /> },
      { path: 'scout', element: <LegacyRoute /> },
      { path: '*', lazy: notFoundRoute },
    ],
  },
  { path: '*', lazy: notFoundRoute, errorElement: <RouteErrorBoundary /> },
])
