import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { legacyDestination, withParams } from '../app/navigation'
import { SectionNavigation } from '../components/SectionNavigation'
import { Drawer, PageHeader } from '../components/ui'
import { ChampionDetailPage } from './ChampionDetailPage'
import { ChampionPerformancePage } from './ChampionPerformancePage'
import { ChampionsPage } from './ChampionsPage'
import { CompetitivePlanPage } from './CompetitivePlanPage'
import { FitPage } from './FitPage'
import { ScoutPage } from './ScoutPage'
import { SynergyPage } from './SynergyPage'
import { TestPlanPage } from './TestPlanPage'

const sections = [
  { id: 'best', label: 'Quali giochi meglio?' },
  { id: 'tournament', label: 'Piano da 400 partite' },
  { id: 'matchups', label: 'Avversari e alleati' },
] as const
const supportedSections = ['choices', ...sections.map((item) => item.id), 'training']

export function ChampionsHubPage() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const requestedSection = params.get('section')
  const section = supportedSections.includes(requestedSection ?? '') ? requestedSection! : 'best'
  const champion = params.get('detail')
  const redirect = legacyDestination(location.pathname, location.search)
  const link = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    next.set(key, value)
    return withParams('/app/fit', next)
  }
  const allies = params.get('relation') === 'allies'
  const plan = params.get('training') === 'plan'
  const secondarySection = section === 'choices' || section === 'training'
  const secondaryHref = (nextSection: string, trainingMode?: string) => {
    const next = new URLSearchParams(params)
    next.set('section', nextSection)
    next.delete('detail')
    next.delete('detailRole')
    if (trainingMode) next.set('training', trainingMode)
    else next.delete('training')
    return withParams('/app/fit', next)
  }
  if (redirect) return <Navigate to={redirect} replace />

  return <div className="page-stack workspace-hub">
    <PageHeader eyebrow="Il tuo spazio / Campioni" title="Campioni" copy="Confronta il rendimento storico e prepara il piano competitivo. Preferenze personali e prove facoltative restano in una sezione separata." />
    <SectionNavigation path="/app/fit" active={section} label="Sezioni campioni" items={sections} />
    <details className="hub-secondary" open={secondarySection}>
      <summary>Preferenze e scoperte <span>Facoltative</span></summary>
      <nav className="hub-secondary__links" aria-label="Preferenze e scoperte facoltative">
        <Link to={secondaryHref('choices')} aria-current={section === 'choices' ? 'page' : undefined}>Familiari e preferiti</Link>
        <Link to={secondaryHref('training', 'discover')} aria-current={section === 'training' && !plan ? 'page' : undefined}>Scopri candidati</Link>
        <Link to={secondaryHref('training', 'plan')} aria-current={section === 'training' && plan ? 'page' : undefined}>Piano di prove</Link>
      </nav>
    </details>
    {section === 'choices' ? <div className="champion-choices"><FitPage /></div>
      : section === 'best' ? <ChampionPerformancePage embedded />
      : section === 'tournament' ? <CompetitivePlanPage embedded />
      : section === 'matchups' ? <>
      <nav className="context-navigation" aria-label="Tipo di confronto">
        <Link to={link('relation', 'enemies')} aria-current={!allies ? 'page' : undefined}>Avversari e ban</Link>
        <Link to={link('relation', 'allies')} aria-current={allies ? 'page' : undefined}>Campioni alleati</Link>
      </nav>
      {allies ? <SynergyPage embedded /> : <ChampionsPage embedded />}
    </> : <>
      <nav className="context-navigation" aria-label="Esplorazione e prove">
        <Link to={link('training', 'discover')} aria-current={!plan ? 'page' : undefined}>Scopri candidati</Link>
        <Link to={link('training', 'plan')} aria-current={plan ? 'page' : undefined}>Piano di prove</Link>
      </nav>
      {plan ? <TestPlanPage embedded /> : <ScoutPage embedded />}
    </>}
    <Drawer wide open={Boolean(champion)} title={champion ? `Scheda di ${champion}` : 'Scheda campione'} description="Risultati, consiglio e confronti. Chiudi la scheda per tornare alla lista con gli stessi filtri." onOpenChange={(open) => {
      if (!open) {
        if (location.state?.championSheetFromList) navigate(-1)
        else setParams((current) => { const next = new URLSearchParams(current); next.delete('detail'); next.delete('detailRole'); return next }, { replace: true })
      }
    }}>
      {champion ? <ChampionDetailPage champion={champion} embedded /> : null}
    </Drawer>
  </div>
}
