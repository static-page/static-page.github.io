/*
 * La vista de carpeta (/account/): entrar, listar, subir, pegar, reemplazar,
 * previsualizar, compartir, borrar y la barra de cuota. Todo contra el Drive
 * simulado de test/google-mock.js.
 *
 * El token vive en la pestaña (sessionStorage), así que una pestaña nueva
 * empieza sin sesión y el botón de Google es el punto de entrada; recargar, en
 * cambio, no vuelve a pedir nada.
 */
const { test, expect } = require('@playwright/test');
const { mockGoogle, PAGE } = require('./google-mock');

const html = (title, body = '') =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

// Las preguntas no son las del navegador: son un <dialog> de la página.
async function answerAsk(page, { accept = true, text = null } = {}) {
  await page.locator('#askDialog').waitFor({ state: 'visible' });
  if (text !== null) await page.locator('#askInput').fill(text);
  await page.locator(accept ? '#btnAskOk' : '#askDialog [data-close-dialog].btn').click();
}

// Entra y espera a que la carpeta esté pintada.
async function signIn(page) {
  await page.locator('#btnSignin').click();
  await page.locator('#folderBox').waitFor({ state: 'visible' });
  // La cuota se pinta al final de reload(): es la señal de que el listado acabó.
  await page.locator('#quotaBox').waitFor({ state: 'visible' });
}

function pick(page, files) {
  return page.setInputFiles('#file', files.map(([name, content, mimeType = 'text/html']) => ({
    name, mimeType, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  })));
}

const rows = (page) => page.locator('#pages .page-row');
const row = (page, name) => page.locator('#pages .page-row', { hasText: name });

/* ------------------------------------------------------------------ entrar */

test('sin sesión se ofrece el botón de Google', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await expect(page.locator('#signinBox')).toBeVisible();
  await expect(page.locator('#btnSignin')).toContainText('Entrar con Google');
  await expect(page.locator('#folderBox')).toBeHidden();
});

test('entrar abre la carpeta y pide solo el scope drive.file', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await expect(page.locator('#signinBox')).toBeHidden();
  await expect(rows(page)).toHaveCount(1);
  const config = await page.evaluate(() => window.__gisConfig);
  expect(config.scope).toBe('https://www.googleapis.com/auth/drive.file');
});

test('la carpeta StaticPage se crea si aún no existe', async ({ page }) => {
  const state = await mockGoogle(page, { folderMissing: true });
  await page.goto('/account/');
  await signIn(page);
  expect(state.folderCreated).toBe(true);
  await expect(page.locator('#folderName')).toHaveText('StaticPage');
});

test('cancelar el acceso deja el botón y explica por qué', async ({ page }) => {
  await mockGoogle(page, { authError: 'auth-cancelled' });
  await page.goto('/account/');
  await page.locator('#btnSignin').click();
  await expect(page.locator('#signinError')).toContainText('Se canceló el acceso');
  await expect(page.locator('#btnSignin')).toBeEnabled();
});

test('si no se alcanza Google se dice', async ({ page }) => {
  await mockGoogle(page, { gisReachable: false });
  await page.goto('/account/');
  await page.locator('#btnSignin').click();
  await expect(page.locator('#signinError')).toContainText('No se pudo contactar con Google');
});

test('sin credenciales en el despliegue no hay carpeta que enseñar', async ({ page }) => {
  await mockGoogle(page, { clientId: '', apiKey: '' });
  await page.goto('/account/');
  await expect(page.locator('#offBox')).toBeVisible();
  await expect(page.locator('#signinBox')).toBeHidden();
});

// Media configuración es peor que ninguna: se publicarían enlaces que este
// mismo despliegue no sabe abrir.
test('sin API key tampoco', async ({ page }) => {
  await mockGoogle(page, { apiKey: '' });
  await page.goto('/account/');
  await expect(page.locator('#offBox')).toBeVisible();
});

test('el token se queda en la pestaña, no en localStorage ni cookies', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: sessionStorage.getItem('staticpage.drive.token'),
    cookie: document.cookie
  }));
  expect(stored.local).toEqual([]);
  expect(JSON.parse(stored.session).value).toBe('fake-token');
  expect(stored.cookie).not.toContain('fake-token');
});

// Pedirle a Google un token «en silencio» al cargar abre una ventana emergente
// que el navegador bloquea. Así que al cargar no se le pide nada.
test('al cargar no se le pide nada a Google', async ({ page }) => {
  let gisHits = 0;
  page.on('request', (req) => { if (req.url().includes('gsi/client')) gisHits += 1; });
  await mockGoogle(page);
  await page.goto('/account/');

  await expect(page.locator('#signinBox')).toBeVisible();
  expect(await page.evaluate(() => window.__authRequests || 0)).toBe(0);
  expect(gisHits).toBe(0);
});

test('recargar mantiene la sesión sin volver a hablar con Google', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  let gisHits = 0;
  page.on('request', (req) => { if (req.url().includes('gsi/client')) gisHits += 1; });
  await page.reload();

  await expect(page.locator('#folderBox')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  expect(gisHits).toBe(0);
});

test('el clic de entrar nunca pide el prompt silencioso', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);
  expect(await page.evaluate(() => window.__authPrompts)).toEqual(['']);
});

test('una pestaña nueva empieza sin sesión', async ({ context, page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  const other = await context.newPage();
  await mockGoogle(other);
  await other.goto('/account/');
  await expect(other.locator('#signinBox')).toBeVisible();
});

test('un 401 tira el token y devuelve al botón', async ({ page }) => {
  await mockGoogle(page, { failList: 401 });
  await page.goto('/account/');
  await page.locator('#btnSignin').click();

  await expect(page.locator('#signinBox')).toBeVisible();
  await expect(page.locator('#signinError')).toContainText('caducó');
  expect(await page.evaluate(() => sessionStorage.getItem('staticpage.drive.token'))).toBeNull();
});

/* ----------------------------------------------------------------- listar */

test('lista carpetas y páginas, con tamaño, fecha y si son públicas', async ({ page }) => {
  await mockGoogle(page, {
    files: [
      { name: 'Proyectos', folder: true },
      { name: 'b.html', content: PAGE },
      { name: 'a.html', content: 'x'.repeat(2048), shared: true }
    ]
  });
  await page.goto('/account/');
  await signIn(page);

  await expect(page.locator('#folders .row')).toHaveText(['Proyectos']);
  await expect(page.locator('#pages .row-name')).toHaveText(['a.html', 'b.html']);
  await expect(row(page, 'a.html').locator('.row-sub')).toHaveText('2,0 KB · 20 oct 2026');
  await expect(row(page, 'a.html').locator('.row-meta')).toHaveText('pública');
  await expect(row(page, 'b.html').locator('.row-meta')).toHaveCount(0);
});

test('cuota: barra con lo usado y el total', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);
  await expect(page.locator('#quotaFigure')).toHaveText('3,0 GB de 15,0 GB');
  await expect(page.locator('#quotaNote')).toContainText('20%');
});

test('cuota sin límite: lo dice en vez de pintar una barra', async ({ page }) => {
  await mockGoogle(page, { quota: { usage: 1024, limit: null } });
  await page.goto('/account/');
  await signIn(page);
  await expect(page.locator('#quotaNote')).toHaveText('Esta cuenta no tiene límite de espacio.');
});

/* ----------------------------------------------------------------- subir */

test('subir un HTML lo guarda en la carpeta con sus bytes intactos', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  const latin = Buffer.from(html('Canción', 'otoño'), 'latin1');
  await pick(page, [['cancion.html', latin]]);
  await expect(rows(page)).toHaveCount(1);

  const saved = state.byFileName('cancion.html');
  expect(saved.mimeType).toBe('text/html');
  expect(saved.parent).toBe(state.folderId);
  expect(saved.content.equals(latin)).toBe(true);
  // Subir no publica: compartir es un paso aparte.
  expect(saved.shared).toBe(false);
});

test('se pueden subir varias a la vez', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);
  await pick(page, [['uno.html', html('1')], ['dos.htm', html('2')]]);
  await expect(page.locator('#pages .row-name')).toHaveText(['dos.htm', 'uno.html']);
});

test('lo que no es HTML se rechaza', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);
  await pick(page, [['foto.png', Buffer.from([137, 80, 78, 71]), 'image/png']]);
  await expect(page.locator('#toast')).toContainText('no es una página HTML');
  expect(state.files).toHaveLength(0);
});

test('más de 10 MB se rechaza sin subir nada', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);
  await pick(page, [['enorme.html', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)]]);
  await expect(page.locator('#toast')).toContainText('pasa de 10,0 MB');
  expect(state.calls.filter((c) => c.path.startsWith('/upload'))).toHaveLength(0);
});

test('mismo nombre: ofrece reemplazar y conserva el archivo', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html', shared: true }] });
  await page.goto('/account/');
  await signIn(page);
  const id = state.files[0].id;

  await pick(page, [['hola.html', html('Nueva')]]);
  await expect(page.locator('#askNote')).toContainText('que ya es público');
  await answerAsk(page);
  await expect(page.locator('#toast')).toContainText('Listo');

  expect(state.files).toHaveLength(1);
  expect(state.files[0].id).toBe(id);
  expect(state.files[0].replaced).toBe(1);
  expect(state.files[0].content.toString()).toContain('<title>Nueva</title>');
  // Los permisos son del archivo: reemplazar el contenido no los toca.
  expect(state.files[0].shared).toBe(true);
});

test('mismo nombre y cancelar: no cambia nada', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await pick(page, [['hola.html', html('Nueva')]]);
  await answerAsk(page, { accept: false });
  await expect(page.locator('#askDialog')).toBeHidden();

  expect(state.files).toHaveLength(1);
  expect(state.files[0].replaced).toBeUndefined();
  expect(state.files[0].content.toString()).toBe(PAGE);
});

test('arrastrar archivos encima de la carpeta también sube', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  const drop = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['<!DOCTYPE html><title>t</title>'], 'soltada.html', { type: 'text/html' }));
    return data;
  });
  await page.dispatchEvent('#folderContent', 'drop', { dataTransfer: drop });
  await expect(rows(page)).toHaveCount(1);
  expect(state.byFileName('soltada.html')).toBeTruthy();
});

/* ------------------------------------------------------------------ pegar */

test('pegar código crea una página nueva', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnPaste').click();
  await page.locator('#pasteName').fill('pegada');
  await page.locator('#pasteCode').fill(html('Pegada', 'ñandú'));
  await page.locator('#btnPasteOk').click();

  await expect(page.locator('#toast')).toContainText('Página creada');
  await expect(rows(page)).toHaveCount(1);
  const saved = state.byFileName('pegada.html');
  expect(saved.content.toString('utf8')).toContain('ñandú');
});

test('sin nombre, la página pegada toma su <title>', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnPaste').click();
  await page.locator('#pasteCode').fill(html('Mi portfolio'));
  await page.locator('#btnPasteOk').click();
  await expect(rows(page)).toHaveCount(1);
  expect(state.byFileName('Mi portfolio.html')).toBeTruthy();
});

test('pegar sin código no crea nada', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnPaste').click();
  await page.locator('#btnPasteOk').click();
  await expect(page.locator('#pasteError')).toHaveText('Falta el código de la página');
  await expect(page.locator('#pasteDialog')).toBeVisible();
  expect(state.files).toHaveLength(0);
});

/* ---------------------------------------------------------- vista previa */

test('la vista previa pinta la página en un marco aislado', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'hola.html').locator('.row-open').click();
  await expect(page.locator('#previewDialog')).toBeVisible();
  await expect(page.locator('#previewTitle')).toHaveText('hola.html');

  const frame = page.locator('#previewStage iframe');
  const sandbox = await frame.getAttribute('sandbox');
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  await expect(page.frameLocator('#previewStage iframe').locator('#hola')).toHaveText('Hola, mundo');
});

// Lo que justifica el sandbox: junto a la vista previa está la sesión de Drive.
test('desde la vista previa la página no alcanza la sesión', async ({ page }) => {
  const probe = html('Sonda', '<p id="out"></p><script>var r = [];' +
    'try { r.push(String(sessionStorage.getItem("staticpage.drive.token"))); } catch (e) { r.push("sin storage"); }' +
    'try { r.push(String(parent.document.title)); } catch (e) { r.push("sin parent"); }' +
    'document.getElementById("out").textContent = r.join(" / ");<\/script>');
  await mockGoogle(page, { files: [{ name: 'sonda.html', content: probe }] });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'sonda.html').locator('.row-open').click();
  await expect(page.frameLocator('#previewStage iframe').locator('#out'))
    .toHaveText('sin storage / sin parent');
});

test('cerrar la vista previa quita el marco', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'hola.html').locator('.row-open').click();
  await expect(page.locator('#previewStage iframe')).toHaveCount(1);
  await page.locator('#previewDialog [data-close-dialog]').click();
  await expect(page.locator('#previewDialog')).toBeHidden();
  await expect(page.locator('#previewStage iframe')).toHaveCount(0);
});

test('«abrir» solo aparece si la página es pública, y en otra pestaña', async ({ page }) => {
  const state = await mockGoogle(page, {
    files: [{ name: 'privada.html' }, { name: 'publica.html', shared: true }]
  });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'privada.html').locator('.row-open').click();
  await expect(page.locator('#btnPreviewOpen')).toBeHidden();
  await page.locator('#previewDialog [data-close-dialog]').click();

  const id = state.byFileName('publica.html').id;
  await row(page, 'publica.html').locator('.row-open').click();
  const open = page.locator('#btnPreviewOpen');
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', new RegExp(`/\\?p=${id}$`));
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener/);
});

test('reemplazar desde la vista previa conserva el id y recarga el marco', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html', shared: true }] });
  await page.goto('/account/');
  await signIn(page);
  const id = state.files[0].id;

  await row(page, 'hola.html').locator('.row-open').click();
  await expect(page.frameLocator('#previewStage iframe').locator('#hola')).toBeVisible();

  await page.setInputFiles('#replaceFile', {
    name: 'otra-cosa.html', mimeType: 'text/html',
    buffer: Buffer.from(html('v2', '<p id="v2">Versión 2</p>'))
  });
  await expect(page.locator('#toast')).toContainText('el enlace no cambia');
  await expect(page.frameLocator('#previewStage iframe').locator('#v2')).toHaveText('Versión 2');

  expect(state.files).toHaveLength(1);
  expect(state.files[0].id).toBe(id);
  expect(state.files[0].name).toBe('hola.html');
  expect(state.files[0].uploadType).toBe('media');
  await expect(page.locator('#previewMeta')).toContainText('21 oct 2026');
});

test('borrar desde la vista previa pregunta antes', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'hola.html').locator('.row-open').click();
  await page.locator('#btnPreviewDelete').click();
  await expect(page.locator('#askNote')).toContainText('Su enlace dejará de funcionar');
  await answerAsk(page);

  await expect(rows(page)).toHaveCount(0);
  expect(state.files).toHaveLength(0);
});

test('borrar y cancelar no borra', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'hola.html').locator('.row-open').click();
  await page.locator('#btnPreviewDelete').click();
  await answerAsk(page, { accept: false });
  await expect(rows(page)).toHaveCount(1);
  expect(state.files).toHaveLength(1);
});

/* -------------------------------------------------------------- compartir */

test('compartir una página la hace pública y da su enlace corto', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);
  const id = state.files[0].id;

  await row(page, 'hola.html').locator('.row-share').click();
  await expect(page.locator('#shareLink')).toHaveValue(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/\\?p=${id}$`));
  expect(state.files[0].shared).toBe(true);
  await expect(row(page, 'hola.html').locator('.row-meta')).toHaveText('pública');
  await expect(page.locator('#btnShareOpen')).toHaveAttribute('rel', /noopener/);
});

test('el enlace compartido abre la página en el visor', async ({ context, page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);
  await row(page, 'hola.html').locator('.row-share').click();
  await expect(page.locator('#shareLink')).toHaveValue(/\?p=/);
  const link = await page.locator('#shareLink').inputValue();

  // Otra pestaña, sin sesión: como quien recibe el enlace.
  const other = await context.newPage();
  await other.route('**/assets/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.STATICPAGE_CONFIG = { googleClientId: "", googleApiKey: "test-api-key" };'
  }));
  await other.route('https://www.googleapis.com/**', (route) => {
    const file = state.files[0];
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/html', body: file.content });
  });
  await other.goto(link);
  await expect(other.locator('#hola')).toHaveText('Hola, mundo');
});

test('con viewerUrl el enlace apunta al visor aparte', async ({ page }) => {
  const state = await mockGoogle(page, {
    files: [{ name: 'hola.html' }],
    viewerUrl: 'https://paginas.example.com'
  });
  await page.goto('/account/');
  await signIn(page);
  await row(page, 'hola.html').locator('.row-share').click();
  await expect(page.locator('#shareLink')).toHaveValue(`https://paginas.example.com/?p=${state.files[0].id}`);
});

test('dejar de compartir la vuelve privada', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html', shared: true }] });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'hola.html').locator('.row-share').click();
  await expect(page.locator('#shareLink')).toHaveValue(/\?p=/);
  await page.locator('#btnUnshare').click();

  await expect(page.locator('#toast')).toContainText('Ya no se comparte');
  expect(state.files[0].shared).toBe(false);
  await expect(row(page, 'hola.html').locator('.row-meta')).toHaveCount(0);
});

test('una cuenta que no puede compartir fuera recibe un aviso claro', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'hola.html' }], failPermission: 403 });
  await page.goto('/account/');
  await signIn(page);

  await row(page, 'hola.html').locator('.row-share').click();
  await expect(page.locator('#toast')).toContainText('no permite compartir fuera de la organización');
  await expect(page.locator('#shareDialog')).toBeHidden();
});

/* -------------------------------------------------------------- carpetas */

test('crear una subcarpeta, entrar y subir dentro', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnNewFolder').click();
  await answerAsk(page, { text: 'Proyectos' });
  await expect(page.locator('#folders .row')).toHaveText(['Proyectos']);

  await page.locator('#folders .row-open').click();
  await expect(page.locator('#folderName')).toHaveText('Proyectos');
  await expect(page).toHaveURL(/\/account\/\?id=/);
  await expect(page.locator('#crumbs')).toBeVisible();

  await pick(page, [['dentro.html', html('Dentro')]]);
  await expect(rows(page)).toHaveCount(1);
  expect(state.byFileName('dentro.html').parent).toBe(state.byFileName('Proyectos').id);
});

test('una carpeta sin nombre no se crea', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnNewFolder').click();
  await page.locator('#btnAskOk').click();
  await expect(page.locator('#askError')).toHaveText('Hace falta un nombre');
  expect(state.folders).toHaveLength(1);
});

test('atrás y las migas vuelven a la raíz', async ({ page }) => {
  await mockGoogle(page, {
    files: [{ name: 'Proyectos', folder: true }, { name: 'raiz.html' }]
  });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#folders .row-open').click();
  await expect(page.locator('#folderName')).toHaveText('Proyectos');
  await expect(rows(page)).toHaveCount(0);

  await page.goBack();
  await expect(page.locator('#folderName')).toHaveText('StaticPage');
  await expect(rows(page)).toHaveCount(1);

  await page.goForward();
  await expect(page.locator('#folderName')).toHaveText('Proyectos');
  await page.locator('#crumbs a').click();
  await expect(page.locator('#folderName')).toHaveText('StaticPage');
});

test('recargar dentro de una subcarpeta sigue en ella', async ({ page }) => {
  await mockGoogle(page, {
    files: [{ name: 'Proyectos', folder: true }, { name: 'dentro.html', parent: 'Proyectos' }]
  });
  await page.goto('/account/');
  await signIn(page);
  await page.locator('#folders .row-open').click();
  await expect(rows(page)).toHaveCount(1);

  await page.reload();
  await expect(page.locator('#folderName')).toHaveText('Proyectos');
  await expect(page.locator('#pages .row-name')).toHaveText(['dentro.html']);
});

test('borrar una subcarpeta vuelve a la de arriba', async ({ page }) => {
  const state = await mockGoogle(page, {
    files: [{ name: 'Proyectos', folder: true }, { name: 'dentro.html', parent: 'Proyectos' }]
  });
  await page.goto('/account/');
  await signIn(page);
  await page.locator('#folders .row-open').click();
  await expect(rows(page)).toHaveCount(1);

  await page.locator('#btnDangerToggle').click();
  await page.locator('#btnDeleteFolder').click();
  await answerAsk(page);

  await expect(page.locator('#folderName')).toHaveText('StaticPage');
  await expect(page.locator('#folders .row')).toHaveCount(0);
  expect(state.files).toHaveLength(0);
});

test('borrar la raíz la vuelve a crear vacía', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnDangerToggle').click();
  await expect(page.locator('#dangerNote')).toContainText('Se vuelve a crear vacía');
  await page.locator('#btnDeleteFolder').click();
  await answerAsk(page);

  await expect(page.locator('#toast')).toContainText('Carpeta borrada');
  await expect(rows(page)).toHaveCount(0);
  expect(state.folderCreated).toBe(true);
});

/* ---------------------------------------------------- carpeta compartida */

test('compartir la carpeta da un enlace de solo lectura', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnShareFolder').click();
  await expect(page.locator('#shareLink')).toHaveValue(new RegExp(`/account/\\?f=${state.folderId}$`));
  expect(state.folderShared).toBe(true);
});

test('una carpeta compartida se ve sin sesión, sin acciones, y enlaza al visor', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'hola.html' }] });
  state.folderShared = true;
  const id = state.files[0].id;
  await page.goto(`/account/?f=${state.folderId}`);

  await expect(page.locator('#folderTitle')).toHaveText('Carpeta compartida');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('#uploadCard')).toBeHidden();
  await expect(page.locator('#addZone')).toBeHidden();
  await expect(page.locator('#dangerZone')).toBeHidden();
  await expect(page.locator('.row-share')).toHaveCount(0);
  await expect(row(page, 'hola.html').locator('.row-open')).toHaveAttribute('href', new RegExp(`/\\?p=${id}$`));

  await row(page, 'hola.html').locator('.row-open').click();
  await expect(page.locator('#hola')).toHaveText('Hola, mundo');
});

test('una carpeta que no es pública lo explica', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto(`/account/?f=${state.folderId}`);
  await expect(page.locator('#emptyNote')).toContainText('dejado de ser pública');
});

test('un id de carpeta malformado no llega a Drive', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/?f=../x');
  await expect(page.locator('#emptyNote')).toContainText('No se pudo abrir la carpeta');
  expect(state.calls).toHaveLength(0);
});
