/*
 * Selector de tema en el pie: automático, claro u oscuro.
 *
 * «auto» se representa quitando el atributo del <html>, de modo que mande
 * prefers-color-scheme; claro y oscuro lo escriben para ganarle.
 */
const { test, expect } = require('@playwright/test');
const { mockGoogle } = require('./google-mock');

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('la portada tiene selector de tema en el pie', async ({ page }) => {
  await page.goto('/');
  const box = page.locator('#landing .foot .theme-switch');
  await expect(box).toBeVisible();
  await expect(box.locator('button')).toHaveText(['Auto', 'Claro', 'Oscuro']);
});

test('la vista de carpeta también lo tiene', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await expect(page.locator('.foot .theme-switch')).toBeVisible();
});

test('arranca en automático, sin atributo', async ({ page }) => {
  await page.goto('/');
  expect(await theme(page)).toBeNull();
  await expect(page.locator('.theme-switch button[data-theme="auto"]'))
    .toHaveAttribute('aria-pressed', 'true');
});

test('elegir oscuro lo aplica y cambia el fondo', async ({ page }) => {
  await page.goto('/');
  const antes = await bg(page);
  await page.locator('.theme-switch button[data-theme="dark"]').click();
  expect(await theme(page)).toBe('dark');
  expect(await bg(page)).not.toBe(antes);
  await expect(page.locator('.theme-switch button[data-theme="dark"]'))
    .toHaveAttribute('aria-pressed', 'true');
});

test('la elección sobrevive a recargar y pasa a la carpeta', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await page.locator('.theme-switch button[data-theme="light"]').click();
  await page.reload();
  expect(await theme(page)).toBe('light');
  await page.goto('/account/');
  expect(await theme(page)).toBe('light');
});

// Claro explícito tiene que ganarle a un sistema en oscuro.
test('claro gana a un sistema oscuro', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const oscuro = await bg(page);
  await page.locator('.theme-switch button[data-theme="light"]').click();
  expect(await bg(page)).not.toBe(oscuro);
});

// Sin localStorage (ventana privada, almacenamiento bloqueado) no se rompe nada.
test('sin localStorage cae en automático', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new Error('bloqueado'); }
    });
  });
  await page.goto('/');
  await expect(page.locator('.theme-switch button[data-theme="auto"]'))
    .toHaveAttribute('aria-pressed', 'true');
  await page.locator('.theme-switch button[data-theme="dark"]').click();
  expect(await theme(page)).toBe('dark');
});
