/*
 * La portada: qué es esto y el camino a la carpeta. Sin credenciales no hay
 * nada que ofrecer, y lo dice.
 */
const { test, expect } = require('@playwright/test');
const { mockGoogle } = require('./google-mock');

test('con credenciales lleva a la carpeta', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');

  await expect(page.locator('#landing')).toBeVisible();
  await expect(page.locator('#viewer')).toBeHidden();
  await expect(page.locator('#ctaBox a')).toHaveAttribute('href', './account/');
  await expect(page.locator('#accountLink')).toBeVisible();
  await expect(page.locator('#offBox')).toBeHidden();
});

test('el enlace de cabecera lleva de verdad a la carpeta', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await page.locator('#accountLink').click();
  await expect(page).toHaveURL(/\/account\/$/);
  await expect(page.locator('#signinBox')).toBeVisible();
});

test('sin credenciales dice que no se puede publicar', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#offBox')).toBeVisible();
  await expect(page.locator('#ctaBox')).toBeHidden();
  await expect(page.locator('#accountLink')).toBeHidden();
});

// Media configuración es peor que ninguna: se publicarían enlaces que este
// despliegue no sabe abrir.
test('con solo una de las dos credenciales tampoco', async ({ page }) => {
  await mockGoogle(page, { apiKey: '' });
  await page.goto('/');
  await expect(page.locator('#offBox')).toBeVisible();
  await expect(page.locator('#ctaBox')).toBeHidden();
});

test('la portada no habla con Google', async ({ page }) => {
  const state = await mockGoogle(page);
  let gisHits = 0;
  page.on('request', (req) => { if (req.url().includes('gsi/client')) gisHits += 1; });
  await page.goto('/');
  await expect(page.locator('#landing')).toBeVisible();
  expect(state.calls).toHaveLength(0);
  expect(gisHits).toBe(0);
});

test('nada se sale de los 390 px', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await expect(page.locator('#landing')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
