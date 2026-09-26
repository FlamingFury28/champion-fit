import { Link, useSearchParams } from 'react-router'
import { sectionHref } from '../app/navigation'

export function SectionNavigation({ path, active, label, items }: {
  path: string
  active: string
  label: string
  items: readonly { id: string; label: string }[]
}) {
  const [params] = useSearchParams()
  return <nav className="section-navigation" aria-label={label}>{items.map((item) =>
    <Link key={item.id} to={sectionHref(path, item.id, params)} aria-current={active === item.id ? 'page' : undefined}>{item.label}</Link>,
  )}</nav>
}
