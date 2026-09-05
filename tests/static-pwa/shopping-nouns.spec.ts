import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createEmptyCookbookConnection, exportedCookbookText, openFreshCookbook, openShopping } from './helpers';

const grouping = (page: Page, name: string) => page.getByRole('group', { name: 'Group shopping list' }).getByRole('button', { name, exact: true });

test('merged shopping rows retain raw recipe blocks and synced aisle memory through reset and ZIP', async ({ page, browser }) => {
  await openFreshCookbook(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove sample recipes' }).click();
  await expect(page.locator('.mep-notices')).toContainText('Removed sample recipes.');
  const today = new Date();
  today.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  const files = {
    'pie.md': '# Pie\n\n---\n\n- *1* aubergine, diced\n- *1/2 tsp* salt\n\n---\n\nBake.\n',
    'soup.md': '# Soup\n\n---\n\n- *1* aubergine, sliced\n- *1/2 tsp* salt\n\n---\n\nSimmer.\n',
    'Aisles.md': '## Herbs, spices & oils\n- salt\n',
    'Plan.md': `## Marked\n\n## ${date}\n- [[pie]]\n- [[soup]]\n`,
  };
  await page.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles(
    Object.entries(files).map(([name, text]) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })));
  await expect(page.locator('.mep-notices')).toContainText('Imported 4 files; skipped 0 existing files. 2 recipes recognised.');
  await page.getByTitle('Close settings').click();
  await page.getByRole('button', { name: 'Planner', exact: true }).click();
  await page.getByRole('button', { name: 'Build shopping list' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(4);
  await page.getByText('1 aubergine, diced', { exact: true }).click();
  await grouping(page, 'Aisle').click();
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  const aubergine = page.getByRole('checkbox', { name: 'aubergine 2', exact: true });
  await expect(aubergine).not.toBeChecked();
  await expect(page.getByLabel('Aisle for salt 1 tsp', { exact: true })).toHaveValue('Herbs, spices & oils');
  await expect(page.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('');
  await expect(page.locator('.shopping-item').filter({ has: aubergine }).locator('.shopping-item__sources')).toHaveText('Pie, Soup');
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  const restoredContext = await browser.newContext();
  const fixture = await createEmptyCookbookConnection();
  try {
    await second.goto(page.url());
    await expect(second.getByRole('checkbox')).toHaveCount(4);
    await grouping(second, 'Aisle').click();
    await page.getByLabel('Aisle for aubergine 2', { exact: true }).selectOption('Fruit & vegetables');
    await expect(second.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('Fruit & vegetables');
    await second.getByLabel('Aisle for aubergine 2', { exact: true }).selectOption('Chilled');
    await expect(page.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('Chilled');
    await page.getByLabel('Aisle for aubergine 2', { exact: true }).selectOption('');
    await expect(second.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('');
    await page.getByLabel('Aisle for aubergine 2', { exact: true }).selectOption('Fruit & vegetables');
    await page.getByText('aubergine 2', { exact: true }).click();
    await expect(aubergine).toBeChecked();
    await expect(second.getByRole('checkbox', { name: 'aubergine 2', exact: true })).toBeChecked();
    await grouping(page, 'None').click();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await grouping(page, 'Recipe').click();
    await expect(page.getByRole('checkbox', { name: '1 aubergine, diced', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '1 aubergine, sliced', exact: true })).toBeChecked();
    expect(await exportedCookbookText(page, 'Shopping.md')).toBe('## Pie\n- [x] *1* aubergine, diced\n- [ ] *1/2 tsp* salt\n\n## Soup\n- [x] *1* aubergine, sliced\n- [ ] *1/2 tsp* salt\n');
    const aisles = await exportedCookbookText(page, 'Aisles.md');
    expect(aisles).toContain('## Fruit & vegetables\n- aubergine');
    await page.getByLabel('More actions').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Reset shopping list', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(second.getByRole('checkbox')).toHaveCount(0);
    expect(await exportedCookbookText(page, 'Aisles.md')).toBe(aisles);
    await page.getByRole('button', { name: 'Planner', exact: true }).click();
    await page.getByRole('button', { name: 'Build shopping list' }).click();
    await grouping(page, 'Aisle').click();
    await expect(page.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('Fruit & vegetables');
    await page.reload();
    await expect(page.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('Fruit & vegetables');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.shopping-list-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/mep-s9k/shopping-merged-phone.png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download cookbook (.zip)' }).click();
    const zip = await readFile((await (await downloading).path())!);
    const restored = await restoredContext.newPage();
    await restored.goto(`/#k=${fixture.id}`);
    await expect(restored.getByRole('heading', { name: 'No recipes yet' })).toBeVisible();
    await restored.getByRole('button', { name: 'Settings', exact: true }).click();
    await restored.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles({ name: 'cookbook.zip', mimeType: 'application/zip', buffer: zip });
    await expect(restored.locator('.mep-notices')).toContainText('2 recipes recognised.');
    await restored.getByTitle('Close settings').click();
    await openShopping(restored);
    await grouping(restored, 'Aisle').click();
    await expect(restored.getByLabel('Aisle for aubergine 2', { exact: true })).toHaveValue('Fruit & vegetables');
    expect(await exportedCookbookText(restored, 'Aisles.md')).toBe(aisles);
  } finally {
    await secondContext.close();
    await restoredContext.close();
    await fixture.close();
  }
});
