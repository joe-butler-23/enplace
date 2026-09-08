import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createEmptyCookbookConnection, exportedCookbookText, openFreshCookbook, openShopping } from './helpers';

const grouping = (page: Page, name: string) => page.getByRole('group', { name: 'Group shopping list' }).getByRole('button', { name, exact: true });

test('preparation-heavy planned recipes produce clean purchase rows without extra disclosures', async ({ page }) => {
  await openFreshCookbook(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove sample recipes' }).click();
  await expect(page.locator('.mep-notices')).toContainText('Removed sample recipes.');
  const today = new Date();
  today.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  const recipes = {
    'a.md': ['*2* green or red peppers (seeded and cut into 2 cm chunks)', '*85 ml* plus 5 ml extra-virgin olive oil, plus more for serving', '*1 tsp* kosher salt'],
    'b.md': ['*30 ml* olive oil', 'fine sea salt', '*10 g* fresh dill leaves (roughly chopped)', '*80 g* ice cubes'],
    'c.md': ['*180 ml* water, warmed to 40 °c', '*10 ml* (2 tsp), plus more for oiling extra-virgin olive oil', '*12 g* granulated sugar', '*250 g* , plus more for dusting plain flour', '*2 g* salt'],
  };
  const files = { ...Object.fromEntries(Object.entries(recipes).map(([path, ingredients]) => [path, `# ${path}\n\n---\n\n${ingredients.map(text => `- ${text}`).join('\n')}\n\n---\n\nCook.\n`])), 'Plan.md': `## ${date}\n- [[a]]\n- [[b]]\n- [[c]]\n` };
  await page.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles(Object.entries(files).map(([name, text]) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })));
  await expect(page.locator('.mep-notices')).toContainText('3 recipes recognised.');
  await page.getByTitle('Close settings').click();
  await page.getByRole('button', { name: 'Planner', exact: true }).click();
  await page.getByRole('button', { name: 'Build shopping list' }).click();
  await grouping(page, 'Aisle').click();
  const names = ['2 green or red peppers', '130 ml olive oil', '≈8 g salt', '10 g fresh dill leaves', '12 g granulated sugar', '250 g plain flour'];
  await expect(page.getByRole('checkbox')).toHaveCount(names.length);
  for (const name of names) await expect(page.getByRole('checkbox', { name, exact: true })).toBeAttached();
  await expect(page.locator('.shopping-group__label', { hasText: /^Other$/ })).toHaveCount(0);
  const oil = page.locator('.shopping-item').filter({ has: page.getByRole('checkbox', { name: '130 ml olive oil', exact: true }) });
  await expect(page.locator('.shopping-item details')).toHaveCount(0);
  await oil.getByText('130 ml olive oil', { exact: true }).click();
  await expect(oil.getByRole('checkbox')).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('.shopping-list-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: '130 ml olive oil', exact: true })).toBeChecked();
  const markdown = await exportedCookbookText(page, 'Shopping.md');
  expect(markdown).toContain('- [x] *85 ml* plus 5 ml extra-virgin olive oil, plus more for serving');
  expect(markdown).toContain('- [x] *10 ml* (2 tsp), plus more for oiling extra-virgin olive oil');
  expect(markdown).toContain('*250 g* , plus more for dusting plain flour');
  expect(markdown).not.toContain('ice cubes');
  expect(markdown).not.toContain('water, warmed');
});

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
    'pie.md': '# Pie\n\n---\n\n- *1* aubergine, diced\n- *1/3 tsp* salt\n\n---\n\nBake.\n',
    'soup.md': '# Soup\n\n---\n\n- *1* aubergine, sliced\n- *2/3 tsp* salt\n\n---\n\nSimmer.\n',
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
  const aubergine = page.getByRole('checkbox', { name: '2 aubergine', exact: true });
  await expect(aubergine).not.toBeChecked();
  await expect(page.getByLabel('Aisle for 1 tsp salt', { exact: true })).toHaveValue('Herbs, spices & oils');
  await expect(page.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('');
  await expect(page.locator('.shopping-item').filter({ has: aubergine }).locator('.shopping-item__sources')).toHaveText('Pie, Soup');
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  const restoredContext = await browser.newContext();
  const fixture = await createEmptyCookbookConnection();
  try {
    await second.goto(page.url());
    await expect(second.getByRole('checkbox')).toHaveCount(4);
    await grouping(second, 'Aisle').click();
    await page.getByLabel('Aisle for 2 aubergine', { exact: true }).selectOption({ value: 'Fruit & vegetables' });
    await expect(second.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('Fruit & vegetables');
    await second.getByLabel('Aisle for 2 aubergine', { exact: true }).selectOption('Chilled');
    await expect(page.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('Chilled');
    await page.getByLabel('Aisle for 2 aubergine', { exact: true }).selectOption('');
    await expect(second.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('');
    await page.getByLabel('Aisle for 2 aubergine', { exact: true }).selectOption('Other');
    await page.getByText('2 aubergine', { exact: true }).click();
    await expect(aubergine).toBeChecked();
    await expect(second.getByRole('checkbox', { name: '2 aubergine', exact: true })).toBeChecked();
    await grouping(page, 'None').click();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await grouping(page, 'Recipe').click();
    await expect(page.getByRole('checkbox', { name: '1 aubergine, diced', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '1 aubergine, sliced', exact: true })).toBeChecked();
    expect(await exportedCookbookText(page, 'Shopping.md')).toBe('## Pie\n- [x] *1* aubergine, diced\n- [ ] *1/3 tsp* salt\n\n## Soup\n- [x] *1* aubergine, sliced\n- [ ] *2/3 tsp* salt\n');
    const aisles = await exportedCookbookText(page, 'Aisles.md');
    expect(aisles).toContain('## Other\n- aubergine');
    await page.getByLabel('More actions').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Reset shopping list', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(second.getByRole('checkbox')).toHaveCount(0);
    expect(await exportedCookbookText(page, 'Aisles.md')).toBe(aisles);
    await page.getByRole('button', { name: 'Planner', exact: true }).click();
    await page.getByRole('button', { name: 'Build shopping list' }).click();
    await grouping(page, 'Aisle').click();
    await expect(page.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('Other');
    await page.reload();
    await expect(page.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('Other');
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
    await expect(restored.getByLabel('Aisle for 2 aubergine', { exact: true })).toHaveValue('Other');
    expect(await exportedCookbookText(restored, 'Aisles.md')).toBe(aisles);
  } finally {
    await secondContext.close();
    await restoredContext.close();
    await fixture.close();
  }
});

test('independent recipe corpus keeps expected purchase counts and aisles through planner, reload and export', async ({ page }) => {
  const corpus: Array<{ title: string; ingredients: Array<{ text: string; purchase: string; aisle: string; include: boolean }> }> =
    JSON.parse(await readFile('tests/fixtures/shopping/development.json', 'utf8'));
  await openFreshCookbook(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove sample recipes' }).click();
  await expect(page.locator('.mep-notices')).toContainText('Removed sample recipes.');
  const today = new Date();
  today.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  const files = corpus.map(({ title, ingredients }, i) => ({
    name: `corpus-${i}.md`, mimeType: 'text/markdown',
    buffer: Buffer.from(`# ${title}\n\n---\n\n${ingredients.map(x => `- ${x.text}`).join('\n')}\n\n---\n\nCook.\n`),
  }));
  files.push({ name: 'Plan.md', mimeType: 'text/markdown', buffer: Buffer.from(`## ${date}\n${corpus.map((_, i) => `- [[corpus-${i}]]`).join('\n')}\n`) });
  await page.locator('.mep-settings__file-button', { hasText: 'Import files' }).locator('input').setInputFiles(files);
  await expect(page.locator('.mep-notices')).toContainText('8 recipes recognised.');
  await page.getByTitle('Close settings').click();
  await page.getByRole('button', { name: 'Planner', exact: true }).click();
  await page.getByRole('button', { name: 'Build shopping list' }).click();
  const included = corpus.flatMap(recipe => recipe.ingredients).filter(x => x.include);
  await expect(page.getByRole('checkbox')).toHaveCount(included.length);
  await grouping(page, 'Aisle').click();
  const purchases = new Map(included.map(x => [x.purchase, x.aisle]));
  await expect(page.getByRole('checkbox')).toHaveCount(purchases.size);
  for (const aisle of new Set(purchases.values())) {
    const section = page.locator('.shopping-group').filter({ has: page.getByText(aisle, { exact: true }).and(page.locator('.shopping-group__label')) });
    await expect(section.getByRole('checkbox')).toHaveCount([...purchases.values()].filter(x => x === aisle).length);
  }
  await expect(page.locator('.shopping-item details')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('checkbox')).toHaveCount(purchases.size);
  const markdown = await exportedCookbookText(page, 'Shopping.md');
  for (const ingredient of included) expect(markdown).toContain(`- [ ] ${ingredient.text}\n`);
});
