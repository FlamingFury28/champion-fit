import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { legacyDestination, withParams, withoutChampionDetail } from '../app/navigation'
import { ChampionSectionNavigation } from '../components/ChampionSectionNavigation'
import { Drawer, PageHeader } from '../components/ui'
import { ChampionDetailPage } from './ChampionDetailPage'
import { ChampionPerformancePage } from './ChampionPerformancePage'
import { ChampionsPage } from './ChampionsPage'
import { CompetitivePlanPage } from './CompetitivePlanPage'
import { FitPage } from './FitPage'
import { ScoutPage } from './ScoutPage'
import { SynergyPage } from './SynergyPage'
import { TestPlanPage } from './TestPlanPage'

const supportedSections = ['best', 'tournament', 'matchups', 'choices', 'training']

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
  if (redirect) return <Navigate to={redirect} replace />

  return <div className="page-stack workspace-hub">
    <PageHeader eyebrow="Il tuo spazio / Campioni" title="Campioni" copy="Confronta il rendimento storico e distribuisci le partite del piano competitivo." />
    <ChampionSectionNavigation section={section} />
    {section === 'choices' ? <div className="champion-choices"><FitPage /></div>
      : section === 'best' ? <ChampionPerformancePage embedded />
      : section === 'tournament' ? <CompetitivePlanPage embedded />
      : section === 'matchups' ? <>
      <nav className="context-navigation" aria-label="Tipo di confronto">
        <Link to={link('relation', 'enemies')} aria-current={!allies ? 'page' : undefined}>Avversari e ban</Link>
        <Link to={link('relation', 'allies')} aria-current={allies ? 'page' : undefined}>Campioni alleati</Link>
      </nav>
      {allies ? <SynergyPage embedded /> : <ChampionsPage embedded />}
    </> : plan ? <TestPlanPage embedded /> : <ScoutPage embedded />}
    <Drawer wide open={Boolean(champion)} title={champion ? `Scheda di ${champion}` : 'Scheda campione'} description="Risultati, consiglio e confronti. Chiudi la scheda per tornare alla lista con gli stessi filtri." onOpenChange={(open) => {
      if (!open) {
        if (location.state?.championSheetFromList) navigate(-1)
        else setParams(withoutChampionDetail, { replace: true })
      }
    }}>
      {champion ? <ChampionDetailPage champion={champion} embedded /> : null}
    </Drawer>
  </div>
}
