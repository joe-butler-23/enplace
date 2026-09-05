import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { exportedCookbookText, openFreshCookbook, openShopping } from './helpers';

test('RecipeMD imports, renders groups and provenance, edits and exports without format loss', async ({ page }) => {
  await openFreshCookbook(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles({
    name: 'standard-soup.md', mimeType: 'text/markdown', buffer: Buffer.from('# Standard soup\n\nA simple soup.\n\nSource: https://example.org/soup\n\n*lunch*\n\n**2 servings**\n\n---\n\n- *400 g* tomatoes\n\n## Finish\n\n- *1/2 tsp* salt\n\n---\n\n1. Simmer the tomatoes.\n2. Season and serve.\n\n## Notes\n\nKeep leftovers chilled.\n'),
  });
  await expect(page.locator('.mep-notices')).toContainText('Imported 1 file');
  await page.getByTitle('Close settings').click();
  await page.getByText('Standard soup', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Finish', exact: true })).toBeVisible();
  await expect(page.getByText('2 servings', { exact: true })).toBeVisible();
  await expect(page.getByText('400 g tomatoes', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'example.org' })).toHaveAttribute('href', 'https://example.org/soup');
  await expect(page.getByText('Keep leftovers chilled.')).toBeVisible();
  await page.getByRole('button', { name: 'Step 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Step 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Recipe markdown', exact: true });
  await editor.fill((await editor.inputValue()).replace('A simple soup.', 'A revised soup.'));
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.reload();
  await page.getByText('Standard soup', { exact: true }).click();
  await expect(page.getByText('A revised soup.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download cookbook (.zip)' }).click();
  const download = await downloading;
  const archive = unzipSync(await readFile((await download.path())!));
  const text = strFromU8(archive['standard-soup.md']);
  expect(text).toContain('*400 g* tomatoes');
  expect(text).toContain('A revised soup.');
  expect(text.startsWith('# Standard soup')).toBe(true);
});

test('shopping grouping, aisle assignment and reset survive reload and reach another device', async ({ page, browser }) => {
  await openFreshCookbook(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles({
    name: 'Shopping.md', mimeType: 'text/markdown', buffer: Buffer.from('## Soup\n- [ ] tomatoes\n- [x] salt\n\n## Bread\n- [ ] flour\n'),
  });
  await page.getByTitle('Close settings').click();
  await openShopping(page);
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  try {
    await second.goto(page.url());
    await expect(second.getByRole('checkbox', { name: 'tomatoes', exact: true })).toBeVisible();
    const grouping = (target: typeof page, name: string) => target.getByRole('group', { name: 'Group shopping list' }).getByRole('button', { name, exact: true });
    await grouping(page, 'Aisle').click();
    await page.getByLabel('Aisle for tomatoes').selectOption('Fruit & vegetables');
    await page.getByLabel('Aisle for flour').selectOption('Baking');
    await expect(page.locator('.shopping-group__label')).toHaveText(['Baking', 'Fruit & vegetables', 'Other']);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.shopping-list-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/enplace-shopping-aisles.png' });
    await grouping(second, 'Aisle').click();
    await expect(second.getByLabel('Aisle for tomatoes')).toHaveValue('Fruit & vegetables');
    await page.reload();
    await expect(grouping(page, 'Aisle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Aisle for tomatoes')).toHaveValue('Fruit & vegetables');
    await grouping(page, 'None').click();
    await expect(page.locator('.shopping-group__label')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await grouping(page, 'Recipe').click();
    await expect(page.locator('.shopping-group__label')).toHaveText(['Soup', 'Bread']);
    await page.getByLabel('More actions').click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Reset shopping list', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Reset shopping list', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(second.getByRole('checkbox')).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Your list is empty — add an item below.')).toBeVisible();
  } finally { await secondContext.close(); }
});


test('shopping build keeps the same ingredient in each planned recipe block', async ({ page }) => {
  await openFreshCookbook(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove sample recipes' }).click();
  await expect(page.locator('.mep-notices')).toContainText('Removed sample recipes.');

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const date = [monday.getFullYear(), monday.getMonth() + 1, monday.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0')).join('-');
  await page.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles([
    {
      name: 'onion-pie.md', mimeType: 'text/markdown',
      buffer: Buffer.from('# Onion Pie\n\n---\n\n- *1* onion\n\n---\n\n1. Bake.\n'),
    },
    {
      name: 'onion-soup.md', mimeType: 'text/markdown',
      buffer: Buffer.from('# Onion Soup\n\n---\n\n- *1* onion\n- salt\n- SALT\n\n---\n\n1. Simmer.\n'),
    },
    {
      name: 'Plan.md', mimeType: 'text/markdown',
      buffer: Buffer.from(`## Marked\n\n## ${date}\n- [[onion-pie]]\n- [[onion-soup]]\n`),
    },
  ]);
  await expect(page.locator('.mep-notices')).toContainText('Imported 3 files');
  await page.getByTitle('Close settings').click();
  await page.getByRole('button', { name: 'Planner', exact: true }).click();
  await page.getByRole('button', { name: 'Build shopping list' }).click();

  const onions = page.getByRole('checkbox', { name: '1 onion', exact: true });
  await expect(onions).toHaveCount(2);
  await expect(page.getByRole('checkbox', { name: 'salt', exact: true })).toHaveCount(1);
  await page.getByText('1 onion', { exact: true }).nth(1).click();
  await expect(onions.nth(0)).not.toBeChecked();
  await expect(onions.nth(1)).toBeChecked();
  await expect(page.locator('.shopping-group__label')).toHaveText(['Onion Pie', 'Onion Soup']);

  const shopping = await exportedCookbookText(page, 'Shopping.md');
  expect(shopping.match(/^- \[[ x]\] \*1\* onion$/gm)).toHaveLength(2);
});
