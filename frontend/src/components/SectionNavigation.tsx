import { Link, useSearchParams } from 'react-router'
import { sectionHref } from '../app/navigation'

export function SectionNavigation({ path, active, label, items, hrefForSection }: {
  path: string
  active: string
  label: string
  items: readonly { id: string; label: string }[]
  hrefForSection?: (section: string) => string | undefined
}) {
  const [params] = useSearchParams()
  return <nav className="section-navigation" aria-label={label}>{items.map((item) => {
    const href = hrefForSection ? hrefForSection(item.id) : sectionHref(path, item.id, params)
    return href === undefined ? <span key={item.id} role="link" aria-disabled="true">{item.label}</span>
      : <Link key={item.id} to={href} aria-current={active === item.id ? 'page' : undefined}>{item.label}</Link>
  })}</nav>
}
