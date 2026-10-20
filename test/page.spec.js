/*
 * assets/page.js, la parte que no pinta nada: qué archivo es una página, cómo
 * se leen sus bytes y cómo se llama. Se ejecuta en el navegador, que es donde
 * vive TextDecoder con todas sus codificaciones.
 */
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.StaticPage));
});

const run = (page, fn, arg) => page.evaluate(fn, arg);

test('reconoce las páginas por tipo o por extensión', async ({ page }) => {
  const result = await run(page, () => [
    StaticPage.isHtmlFile({ name: 'a.html', type: '' }),
    StaticPage.isHtmlFile({ name: 'a.HTM', type: '' }),
    StaticPage.isHtmlFile({ name: 'sin-extension', type: 'text/html' }),
    StaticPage.isHtmlFile({ name: 'a.txt', type: 'text/plain' }),
    StaticPage.isHtmlFile({ name: 'a.svg', type: 'image/svg+xml' })
  ]);
  expect(result).toEqual([true, true, true, false, false]);
});

test('nombres: un solo segmento, sin control, con .html', async ({ page }) => {
  const result = await run(page, () => [
    StaticPage.htmlName('../../etc/passwd'),
    StaticPage.htmlName('C:\\Users\\yo\\portfolio.htm'),
    StaticPage.htmlName('mi\u0000pá\u0007gina'),
    StaticPage.htmlName('   '),
    StaticPage.htmlName('x'.repeat(300)).length
  ]);
  expect(result).toEqual(['passwd.html', 'portfolio.htm', 'mipágina.html', 'pagina.html', 125]);
});

test('decodifica: BOM, UTF-8 válido, <meta charset> y windows-1252', async ({ page }) => {
  const result = await run(page, () => {
    const bytes = (list) => new Uint8Array(list);
    const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
    return [
      // BOM UTF-8: se respeta y no aparece en el texto
      StaticPage.decode(bytes([0xEF, 0xBB, 0xBF, 0xC3, 0xB1])),
      // UTF-8 válido sin declarar
      StaticPage.decode(bytes([0xC3, 0xB1])),
      // UTF-8 válido aunque el <meta> mienta: mandan los bytes
      StaticPage.decode(bytes(ascii('<meta charset="windows-1252">').concat([0xC3, 0xB1]))).slice(-1),
      // No es UTF-8 y declara iso-8859-15: el euro está en 0xA4
      StaticPage.decode(bytes(ascii('<meta charset=iso-8859-15>').concat([0xA4]))).slice(-1),
      // No es UTF-8 y no declara nada: windows-1252, donde el euro está en 0x80
      StaticPage.decode(bytes([0x80])),
      // UTF-16 con BOM
      StaticPage.decode(bytes([0xFF, 0xFE, 0x41, 0x00, 0xF1, 0x00])),
      // Una etiqueta desconocida no rompe: cae en UTF-8
      StaticPage.decode(bytes(ascii('<meta charset="klingon">').concat([0xFF]))).length > 0
    ];
  });
  expect(result).toEqual(['ñ', 'ñ', 'ñ', '€', '€', 'Añ', true]);
});

test('distingue un binario de una página', async ({ page }) => {
  const result = await run(page, () => [
    StaticPage.looksBinary(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])),
    StaticPage.looksBinary(new TextEncoder().encode('<!DOCTYPE html><p>hola</p>')),
    StaticPage.looksBinary(new Uint8Array([0xFF, 0xFE, 0x3C, 0x00, 0x70, 0x00]))
  ]);
  expect(result).toEqual([true, false, false]);
});

// DOMParser no ejecuta nada: leer el título de una página ajena es inocuo.
test('lee el <title> sin ejecutar la página', async ({ page }) => {
  const result = await run(page, () => {
    window.__ran = false;
    const title = StaticPage.titleOf(
      '<title>  Mi página </title><script>window.__ran = true<\/script><img src=x onerror="window.__ran = true">');
    return { title, empty: StaticPage.titleOf('<p>sin título</p>'), ran: window.__ran };
  });
  await page.waitForTimeout(100);
  expect(result).toEqual({ title: 'Mi página', empty: '', ran: false });
  expect(await page.evaluate(() => window.__ran)).toBe(false);
});

test('el sandbox de la vista previa nunca incluye allow-same-origin', async ({ page }) => {
  const result = await run(page, () => {
    const frame = StaticPage.previewFrame('<p>x</p>', 'x');
    return { attr: frame.getAttribute('sandbox'), constant: StaticPage.SANDBOX };
  });
  expect(result.attr).toBe(result.constant);
  expect(result.attr).toContain('allow-scripts');
  expect(result.attr).not.toContain('allow-same-origin');
  expect(result.attr).not.toContain('allow-top-navigation');
});

test('formatea tamaños en español', async ({ page }) => {
  const result = await run(page, () => [0, 1023, 2048, 10 * 1024 * 1024, 3 * 1024 ** 3]
    .map(StaticPage.formatBytes));
  expect(result).toEqual(['0 B', '1023 B', '2,0 KB', '10,0 MB', '3,0 GB']);
});
