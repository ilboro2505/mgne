import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

async function ready(page: Page) {
  await expect(page.locator('#status-text')).toHaveText('Готов к запуску');
}

async function downloadJson(page: Page, button: string) {
  await page.locator('#export-toggle').click();
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const download = await pending;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await ready(page);
});

test('WASM loads, steps and runs batches; pause stops further advancement', async ({ page }) => {
  const exceptions: string[] = [];
  page.on('pageerror', error => exceptions.push(error.message));
  await expect(page.locator('[data-neuron]')).toHaveCount(6);
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('1');
  await expect(page.locator('#time-value')).toHaveText('1.022');
  await expect(page.locator('.chart-spike')).toHaveCount(1);
  await page.locator('#batch-100').click();
  await expect(page.locator('#event-value')).toHaveText('101');
  await ready(page);
  await page.locator('#run').click();
  await expect(page.locator('#run')).toHaveText('Пауза');
  await expect.poll(async () => Number(await page.locator('#event-value').innerText())).toBeGreaterThan(101);
  await page.locator('#run').click();
  await ready(page);
  const stopped = await page.locator('#event-value').innerText();
  // Wait across several animation intervals; the model must stay paused.
  await page.waitForTimeout(180);
  await expect(page.locator('#event-value')).toHaveText(stopped);
  expect(exceptions).toEqual([]);
});

test('draft edits require apply; invalid parameters are rejected and recoverable', async ({ page }) => {
  await page.locator('#threshold').fill('-1');
  await page.locator('#threshold').blur();
  await expect(page.locator('#step')).toBeDisabled();
  await page.locator('#apply').click();
  await expect(page.getByRole('alert')).toContainText('threshold');
  await expect(page.locator('#step')).toBeDisabled();
  await page.locator('#threshold').fill('18');
  await page.locator('#threshold').blur();
  await page.locator('#apply').click();
  await ready(page);
  await expect(page.locator('#event-value')).toHaveText('0');
  await expect(page.getByRole('alert')).toBeHidden();
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('1');
});

test('topology and matrix edits produce an executable configuration', async ({ page }) => {
  await page.locator('#add-neuron').click();
  await expect(page.locator('[data-neuron]')).toHaveCount(7);
  await page.locator('#fully-connect').click();
  await expect(page.locator('#network-value')).toHaveText('7 / 42');
  await page.locator('#tab-matrix').click();
  const weight = page.getByRole('spinbutton', { name: 'Вес 1 → 2', exact: true });
  await weight.fill('2.5');
  await weight.blur();
  await page.locator('#apply').click();
  await ready(page);
  const saved = await downloadJson(page, '#export-config');
  expect(saved.connections.find((edge: { source: string; target: string }) => edge.source === '1' && edge.target === '2').weight).toBe(2.5);
  await page.locator('#delete-neuron').click();
  await expect(page.locator('#network-value')).toHaveText('6 / 30');
  await page.locator('#apply').click();
  await ready(page);
  await page.locator('#batch-100').click();
  await expect(page.locator('#event-value')).toHaveText('100');
  await expect(page.getByRole('alert')).toBeHidden();
});

test('snapshot download and import resume state; invalid import preserves it', async ({ page }) => {
  await page.locator('#batch-100').click();
  await expect(page.locator('#event-value')).toHaveText('100');
  await ready(page);
  const snapshot = await downloadJson(page, '#export-snapshot');
  expect(snapshot.eventCount).toBe(100);
  expect(snapshot.activeInputs).toHaveLength(6);
  await page.locator('#reset').click();
  await ready(page);
  await expect(page.locator('#event-value')).toHaveText('0');
  await page.locator('#import-file').setInputFiles({ name: 'checkpoint.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.locator('#event-value')).toHaveText('100');
  await expect(page.locator('#time-value')).toHaveText(snapshot.time.toFixed(3));
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('101');
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#event-value')).toHaveText('101');
  await page.locator('#dismiss-error').click();
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('102');
});

test('silent detector halts; stimulated detector produces spikes and exports CSV', async ({ page }) => {
  await page.locator('#preset').selectOption('silent-detector');
  await expect(page.locator('#status-text')).toHaveText('Нет будущих событий');
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#step')).toBeDisabled();
  await expect(page.locator('#time-value')).toHaveText('0.000');
  await page.locator('#preset').selectOption('detector-ring');
  await ready(page);
  await expect(page.locator('#model-version')).toContainText('mone-initial-drive-v1');
  await page.locator('#batch-100').click();
  await expect(page.locator('#event-value')).toHaveText('100');
  await ready(page);
  await expect.poll(() => page.locator('.chart-spike').count()).toBeGreaterThan(1);
  await page.locator('#export-toggle').click();
  const pending = page.waitForEvent('download');
  await page.locator('#export-events').click();
  expect((await pending).suggestedFilename()).toBe('mone-events-window.csv');
});

test('mobile layout has no horizontal overflow and remains operable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('1');
  await page.locator('#tab-potential').click();
  await expect(page.locator('#chart-caption')).toContainText('состояния после команд');
});

test('renaming a neuron preserves its connections; duplicate IDs are rejected', async ({ page }) => {
  await page.locator('#neuron-id').fill('Источник');
  await page.locator('#neuron-id').blur();
  await expect(page.locator('#selected-title')).toHaveAttribute('title', 'Источник');
  await page.locator('#apply').click();
  await ready(page);
  const config = await downloadJson(page, '#export-config');
  expect(config.neurons[0].id).toBe('Источник');
  expect(config.connections.filter((edge: { source: string; target: string }) => edge.source === 'Источник' || edge.target === 'Источник')).toHaveLength(2);
  expect(config.connections.some((edge: { source: string; target: string }) => edge.source === '1' || edge.target === '1')).toBe(false);
  await page.locator('#neuron-id').fill('2');
  await page.locator('#neuron-id').blur();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.locator('#dismiss-error').click();
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('1');
});

test('difference plot supports independent cycle offsets and retains indices after window truncation', async ({ page }) => {
  await page.locator('#batch-1000').click();
  await expect(page.locator('#event-value')).toHaveText('1000');
  await ready(page);
  await page.locator('#batch-1000').click();
  await expect(page.locator('#event-value')).toHaveText('2000');
  await ready(page);
  await page.locator('#tab-difference').click();
  await expect(page.locator('#phase-chart')).toBeVisible();
  await expect(page.locator('#phase-chart .chart-trace')).toBeAttached();
  expect((await page.locator('#phase-chart .chart-trace').first().getAttribute('points'))?.split(' ').length).toBeGreaterThan(2);
  await expect(page.locator('#chart-caption')).toContainText('сохраняются при обрезке');
  const original = await page.locator('#phase-chart').innerHTML();
  await page.locator('#phase-target-offset').selectOption('1');
  await expect(page.locator('.phase-readout')).toContainText('t₂(i + 1)');
  expect(await page.locator('#phase-chart').innerHTML()).not.toBe(original);
  await page.locator('#phase-source-offset').selectOption('1');
  await expect(page.locator('.phase-readout')).toContainText('t₁(i + 1)');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('CSV preserves causal order and positive intervals when rounded timestamps coincide', async ({ page }) => {
  await page.locator('#import-file').setInputFiles(fileURLToPath(new URL('../fixtures/causal-cascade.json', import.meta.url)));
  await ready(page);
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('1');
  await page.locator('#step').click();
  await expect(page.locator('#event-value')).toHaveText('2');
  await page.locator('#export-toggle').click();
  const pending = page.waitForEvent('download');
  await page.locator('#export-events').click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => line.split(','));
  expect(rows[0]).toEqual(['time', 'delta', 'group_index', 'event', 'neuron', 'spike_index']);
  expect(rows[1][0]).toBe(rows[2][0]);
  expect(Number(rows[2][1])).toBeGreaterThan(0);
  expect(rows.slice(1).map(row => row[2])).toEqual(['1', '2']);
  expect(rows.slice(1).map(row => row[4])).toEqual(['"source"', '"target"']);
});
