import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.addInitScript(() => {
    if (localStorage.getItem('champion-fit-profile-groups') !== null) return
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    localStorage.setItem('champion-fit-profile-groups', JSON.stringify({
      Duo: ['Beta#EUW'], Alternativa: ['Beta#EUW'], Principale: ['Alpha#EUW'],
    }))
  })
  await page.goto('/app/profile')
  await expect(page.locator('.selected-account-list').getByRole('button', { name: /^Alpha#EUW/ })).toBeVisible()
  await page.reload()
})

for (const reason of ['eliminazione', 'cambio account'] as const) {
  test(`il filtro compagni scarta il profilo non più applicabile dopo ${reason} @smoke`, async ({ page }) => {
    const select = page.getByRole('combobox', { name: 'Profilo dei compagni', exact: true })
    const apply = page.getByRole('button', { name: 'Applica filtro', exact: true })
    await select.selectOption('Duo')
    await expect(apply).toBeEnabled()

    if (reason === 'eliminazione') {
      await page.getByRole('button', { name: 'Elimina profilo Duo', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Conferma eliminazione', exact: true }).click()
    } else {
      await page.locator('.selected-account-list').getByRole('button', { name: /^Beta#EUW/ }).click()
    }
    await expect(select).toHaveValue('')
    await expect(select.getByRole('option', { name: /^Duo ·/ })).toHaveCount(0)
    await expect(apply).toBeDisabled()

    const replacement = reason === 'eliminazione' ? 'Alternativa' : 'Principale'
    if (reason === 'cambio account') {
      await page.locator('.selected-account-list').getByRole('button', { name: /^Alpha#EUW/ }).click()
    }
    await select.selectOption(replacement)
    await apply.click()
    await expect(page.locator('.active-companion')).toContainText(replacement)
    await page.reload()
    await expect(page.locator('.active-companion')).toContainText(replacement)
    await expect(select).toHaveValue('')
    await expect(apply).toBeDisabled()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-companion-filter') ?? 'null'))).toMatchObject({
      name: replacement, mode: 'exclude',
      accounts: [reason === 'eliminazione' ? 'Beta#EUW' : 'Alpha#EUW'],
    })
  })
}
