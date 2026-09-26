import '@fontsource-variable/fraunces'
import '@fontsource-variable/manrope'
import '@fontsource/dm-mono/400.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './app/router'
import { initializeAppearance } from './app/appearance'
import { initializeDataView } from './app/data-view'
import './styles.css'
import './experience.css'
import './appearance.css'
import './navigation.css'

initializeAppearance()
initializeDataView()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
