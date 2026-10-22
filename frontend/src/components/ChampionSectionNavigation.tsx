import { Link, useSearchParams } from 'react-router'
import { getSetting, useAlgorithmSettings } from '../app/algorithm-settings'
import { sectionHref, type ResolvedRecommendationContext } from '../app/navigation'
import { recommendationListFilters } from '../app/recommendation-filters'
import { useRecommendationNavigationContext } from '../app/use-recommendation-navigation-context'
import { useScope } from '../app/scope'
import { SectionNavigation } from './SectionNavigation'

const sections = [
  { id: 'best', label: 'Quali giochi meglio?' },
  { id: 'tournament', label: 'Piano competitivo' },
] as const
const commonSections = ['best', 'tournament', 'matchups']

function NavigationLinks({ section, params, context }: {
  section: string
  params: URLSearchParams
  context?: ResolvedRecommendationContext | null
}) {
  const alliesAndEnemies = section === 'matchups'
  const secondarySection = alliesAndEnemies || section === 'choices' || section === 'training'
  const plan = params.get('training') === 'plan'
  const href = (target: string, source = params) => {
    if (context === null && commonSections.includes(target)) return undefined
    return sectionHref('/app/fit', target, source, context ?? undefined)
  }
  const secondaryHref = (target: string, training?: string) => {
    const next = new URLSearchParams(params)
    if (training) next.set('training', training)
    else next.delete('training')
    return href(target, next)
  }
  const comparisonsHref = secondaryHref('matchups')
  return <>
    <SectionNavigation path="/app/fit" active={section} label="Sezioni campioni" items={sections} hrefForSection={href} />
    <details className="hub-secondary" open={secondarySection}>
      <summary>Altri strumenti <span>Confronti, preferenze e prove</span></summary>
      <nav className="hub-secondary__links" aria-label="Confronti aggiuntivi">
        {comparisonsHref === undefined
          ? <span role="link" aria-disabled="true">Avversari e alleati</span>
          : <Link to={comparisonsHref} aria-current={alliesAndEnemies ? 'page' : undefined}>Avversari e alleati</Link>}
      </nav>
      <p className="hub-secondary__label">Preferenze e scoperte · Facoltative</p>
      <nav className="hub-secondary__links" aria-label="Preferenze e scoperte facoltative">
        <Link to={secondaryHref('choices')!} aria-current={section === 'choices' ? 'page' : undefined}>Familiari e preferiti</Link>
        <Link to={secondaryHref('training', 'discover')!} aria-current={section === 'training' && !plan ? 'page' : undefined}>Scopri candidati</Link>
        <Link to={secondaryHref('training', 'plan')!} aria-current={section === 'training' && plan ? 'page' : undefined}>Piano di prove</Link>
      </nav>
    </details>
    {context === null ? <p className="context-note" role="status">I confronti attendono l’aggiornamento di ruolo e modalità.</p> : null}
  </>
}

function AutomaticNavigation({ section, params }: { section: string; params: URLSearchParams }) {
  const { scope, scopeReady } = useScope()
  const filters = recommendationListFilters(params, section === 'choices' ? 'choices' : 'training')
  const context = useRecommendationNavigationContext(scope, filters, scopeReady)
  return <NavigationLinks section={section} params={params} context={context} />
}

export function ChampionSectionNavigation({ section }: { section: string }) {
  const [params] = useSearchParams()
  const { settings } = useAlgorithmSettings()
  const filters = recommendationListFilters(params, section === 'choices' ? 'choices' : 'training')
  const automatic = ['choices', 'training'].includes(section)
    && (filters.role === 'AUTO' || filters.queue === 'auto'
      || (!filters.queue && getSetting(settings, 'recommendations.queue') === 'auto'))
  // Only this navigation subtree switches observers; the page and its draft
  // remain mounted when an automatic filter becomes concrete or vice versa.
  return automatic ? <AutomaticNavigation section={section} params={params} /> : <NavigationLinks section={section} params={params} />
}
