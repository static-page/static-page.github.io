/*
 * El visor (/?p=<id>): trae de Drive una página pública y la pone en lugar
 * del documento entero, sin iframe.
 *
 * Lo que estas pruebas NO demuestran: que Google responda así. La lectura
 * anónima —`files.get?alt=media` con API key desde otro origen— necesita
 * cabeceras CORS, que aquí se dan por supuestas.
 */
const { test, expect } = require('@playwright/test');
const { mockGoogle } = require('./google-mock');

const page$ = (body, head = '') =>
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Publicada</title>' +
  head + '</head><body>' + body + '</body></html>';

// Publica una página en el Drive simulado y devuelve su id.
async function publish(page, content, extra = {}) {
  const state = await mockGoogle(page, {
    files: [{ name: 'pagina.html', content, shared: true, ...extra }],
    ...(extra.mock || {})
  });
  return { state, id: state.files[0].id };
}

/* ---------------------------------------------------------- sustitución */

test('la página sustituye al documento entero', async ({ page }) => {
  const { id } = await publish(page, page$('<h1 id="hola">Hola, mundo</h1>'));
  await page.goto(`/?p=${id}`);

  await expect(page.locator('#hola')).toHaveText('Hola, mundo');
  await expect(page).toHaveTitle('Publicada');
  // Nada del visor sobrevive: ni su marcado ni su hoja de estilos.
  await expect(page.locator('#viewer')).toHaveCount(0);
  await expect(page.locator('link[href*="style.css"]')).toHaveCount(0);
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  // La URL sigue siendo la del enlace compartido.
  expect(page.url()).toContain(`/?p=${id}`);
});

test('se respeta el doctype: modo estándar', async ({ page }) => {
  const { id } = await publish(page, page$('<p id="x">x</p>'));
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toBeVisible();
  expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat');
});

test('sus scripts se ejecutan, y le llegan DOMContentLoaded y load', async ({ page }) => {
  const script =
    '<script>window.log = ["inline"];' +
    'document.addEventListener("DOMContentLoaded", function () { log.push("dcl"); });' +
    'window.addEventListener("load", function () { log.push("load"); ' +
    'document.getElementById("out").textContent = log.join(","); });<\/script>';
  const { id } = await publish(page, page$('<p id="out"></p>', script));
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#out')).toHaveText('inline,dcl,load');
});

test('la página empieza con un global limpio', async ({ page }) => {
  const { id } = await publish(page, page$('<p id="x">x</p>'));
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toBeVisible();

  const leftovers = await page.evaluate(() =>
    ['StaticPage', 'StaticPageDrive', 'StaticPageTheme', 'STATICPAGE_CONFIG']
      .filter((name) => typeof window[name] !== 'undefined'));
  expect(leftovers).toEqual([]);
});

// Si la pestaña venía de la carpeta, el token de Drive está en su
// sessionStorage, y la página publicada se ejecuta en el mismo origen.
test('el token de Drive de la pestaña no llega a la página', async ({ page }) => {
  const probe = '<script>document.addEventListener("DOMContentLoaded", function () {' +
    'document.getElementById("out").textContent = String(sessionStorage.getItem("staticpage.drive.token"));' +
    '});<\/script>';
  const { id } = await publish(page, page$('<p id="out"></p>', probe));

  await page.goto('/');
  await page.evaluate(() => sessionStorage.setItem('staticpage.drive.token', JSON.stringify({
    value: 'fake-token', expiresAt: Date.now() + 3600000,
    clientId: 'test-client-id.apps.googleusercontent.com'
  })));
  await page.goto(`/?p=${id}`);

  await expect(page.locator('#out')).toHaveText('null');
});

test('el visor nunca carga la biblioteca de Google', async ({ page }) => {
  let gisHits = 0;
  page.on('request', (req) => { if (req.url().includes('gsi/client')) gisHits += 1; });
  const { id } = await publish(page, page$('<p id="x">x</p>'));
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toBeVisible();
  expect(gisHits).toBe(0);
});

test('la lectura es anónima: API key y sin cabecera Authorization', async ({ page }) => {
  const { id, state } = await publish(page, page$('<p id="x">x</p>'));
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toBeVisible();

  const media = state.calls.filter((c) => c.search.includes('alt=media'));
  expect(media).toHaveLength(1);
  expect(media[0].search).toContain('key=test-api-key');
  expect(media[0].headers.authorization).toBeUndefined();
});

test('los enlaces a un ancla funcionan dentro de la página', async ({ page }) => {
  const body = '<a id="go" href="#abajo">bajar</a><div style="height:3000px"></div>' +
    '<h2 id="abajo">Abajo</h2>';
  const { id } = await publish(page, page$(body));
  await page.goto(`/?p=${id}`);

  await page.locator('#go').click();
  await expect(page).toHaveURL(new RegExp(`\\?p=${id}#abajo$`));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  await expect(page.locator('#abajo')).toBeInViewport();
});

// El tema de StaticPage es de StaticPage: la página publicada no lo hereda.
test('la página no hereda el tema oscuro del sitio', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { id } = await publish(page, page$('<p id="x">x</p>'));
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('staticpage-theme', 'dark'));
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toBeVisible();

  const look = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor
  }));
  expect(look.theme).toBeNull();
  expect(look.bg).toBe('rgba(0, 0, 0, 0)');
});

/* ---------------------------------------------------------- codificación */

test('una página en windows-1252 se lee con su codificación', async ({ page }) => {
  const latin = Buffer.from(
    '<!DOCTYPE html><html><head><meta charset="windows-1252"><title>Canción</title></head>' +
    '<body><p id="x">Canción de otoño</p></body></html>', 'latin1');
  const { id } = await publish(page, latin);
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toHaveText('Canción de otoño');
  await expect(page).toHaveTitle('Canción');
});

test('UTF-8 sin <meta charset> también', async ({ page }) => {
  const { id } = await publish(page, '<!DOCTYPE html><p id="x">Año ñandú — ✓</p>');
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#x')).toHaveText('Año ñandú — ✓');
});

/* --------------------------------------------------------------- errores */

test('un id malformado no llega a Drive', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/?p=../../evil');
  await expect(page.locator('#viewerMsg')).toContainText('dañado');
  expect(state.calls).toHaveLength(0);
});

test('una página que no es pública explica qué pasa y ofrece Drive', async ({ page }) => {
  const { id } = await publish(page, page$('<p>x</p>'), { shared: false });
  await page.goto(`/?p=${id}`);

  await expect(page.locator('#viewerMsg')).toContainText('dejado de ser pública');
  await expect(page.locator('#viewerSpinner')).toBeHidden();
  await expect(page.locator('#viewerDrive')).toHaveAttribute('href',
    `https://drive.google.com/file/d/${id}/view`);
  await expect(page.locator('#viewerLinks a[href="./"]')).toBeVisible();
});

test('sin API key el visor lo dice', async ({ page }) => {
  await mockGoogle(page, { apiKey: '' });
  await page.goto('/?p=1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  await expect(page.locator('#viewerMsg')).toContainText('no tiene configurada la lectura');
});

test('un binario no se pinta como página', async ({ page }) => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20, 0), Buffer.from('fin')]);
  const { id } = await publish(page, pdf, { mimeType: 'application/pdf' });
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#viewerMsg')).toContainText('no es una página HTML');
});

test('una página vacía tampoco', async ({ page }) => {
  const { id } = await publish(page, '');
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#viewerMsg')).toContainText('vacía');
});

test('un archivo de más de 10 MB no se descarga entero', async ({ page }) => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0x61);
  const { id } = await publish(page, big);
  await page.goto(`/?p=${id}`);
  await expect(page.locator('#viewerMsg')).toContainText('pesa más de 10,0 MB');
});
