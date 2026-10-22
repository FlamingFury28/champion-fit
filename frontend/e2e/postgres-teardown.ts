import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export default function postgresTeardown() {
  if (!process.env.CHAMPION_FIT_E2E_POSTGRES_MANIFEST) return
  const script = fileURLToPath(new URL('./seed_and_serve.py', import.meta.url))
  execFileSync('python', [script, '--cleanup-postgres-fixture'], {
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 30_000,
  })
}
