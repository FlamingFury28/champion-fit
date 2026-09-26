import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
}

const routes = [
  ['landing', '/'],
  ['overview', '/app/overview'],
  ['profile', '/app/profile'],
  ['choices', '/app/fit'],
  ['opponents', '/app/fit?section=matchups&relation=enemies'],
  ['allies', '/app/fit?section=matchups&relation=allies'],
  ['discover', '/app/fit?section=training&training=discover'],
  ['plan', '/app/fit?section=training&training=plan'],
  ['champion', '/app/fit?detail=Ahri&detailRole=MIDDLE'],
  ['matches', '/app/matches?flag=all'],
  ['playstyles', '/app/matches?section=style'],
  ['friends', '/app/team/friends'],
] as const

for (const [name, route] of routes) {
  test(`axe · ${name}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'La matrice axe completa viene eseguita una volta su Chromium')
    await page.goto(route)
    if (name === 'champion') await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
    else await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expectNoSeriousAxeViolations(page)
  })
}

test('axe · dialog e drawer aperti', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Gli overlay vengono verificati una volta su Chromium')
  await page.goto('/app/matches?flag=all')
  await page.getByRole('button', { name: /^Apri annotazione:/ }).first().click()
  await expectNoSeriousAxeViolations(page)

  await page.goto('/app/fit?detail=Ahri&detailRole=MIDDLE')
  await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
  await expectNoSeriousAxeViolations(page)
})
