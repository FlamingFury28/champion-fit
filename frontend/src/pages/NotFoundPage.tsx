import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <section className="not-found">
      <span>404</span>
      <p className="eyebrow">Pagina non trovata</p>
      <h1>Pagina non trovata</h1>
      <p>Non esiste una pagina a questo indirizzo.</p>
      <Link className="button" to="/app/overview"><ArrowLeft aria-hidden="true" /> Torna al riepilogo</Link>
    </section>
  )
}
