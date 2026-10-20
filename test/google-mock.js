/*
 * Un Google Drive de mentira, con estado, para las suites.
 *
 * Cubre lo que la app usa: buscar/crear la carpeta, listar, subir, reemplazar,
 * leer, borrar, compartir y dejar de compartir, y la cuota. Un único manejador
 * para todo googleapis.com que despacha por método y ruta, para no depender
 * del orden en que Playwright resuelve las rutas.
 *
 * Lo que NO demuestra: que Google se comporte así. En particular las cabeceras
 * CORS de la lectura y el listado anónimos se dan por supuestas aquí.
 */
const CORS = { 'Access-Control-Allow-Origin': '*' };
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const HTML_MIME = 'text/html';

const PAGE =
  '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Hola</title></head>' +
  '<body><h1 id="hola">Hola, mundo</h1></body></html>';

let seq = 0;
function newId(prefix) {
  seq += 1;
  return (prefix + '0123456789abcdefghij').slice(0, 24) + String(seq).padStart(4, '0');
}

const asBuffer = (content) => Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

// multipart/related a mano: metadatos JSON y contenido, con los bytes intactos.
function parseMultipart(buffer, contentType) {
  const boundary = (contentType.match(/boundary=([^;]+)/) || [])[1];
  const text = buffer.toString('latin1');
  const parts = text.split('--' + boundary);
  const body = (part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  const meta = JSON.parse(Buffer.from(body(parts[1]), 'latin1').toString('utf8'));
  const content = Buffer.from(body(parts[2]), 'latin1');
  return { meta, content };
}

async function mockGoogle(page, options = {}) {
  const opts = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    apiKey: 'test-api-key',
    viewerUrl: '',
    authError: null,
    gisReachable: true,
    files: [],              // [{ name, content, shared, folder, parent, mimeType }]
    folderMissing: false,   // la carpeta StaticPage aún no existe
    quota: { usage: 3 * 1024 * 1024 * 1024, limit: 15 * 1024 * 1024 * 1024 },
    failList: 0,
    failUpload: 0,
    failDelete: 0,
    failPermission: 0,
    failMedia: 0,
    ...options
  };

  const folderId = newId('fold');
  const store = new Map();
  store.set(folderId, {
    id: folderId, name: 'StaticPage', parent: null, shared: false, mimeType: FOLDER_MIME
  });
  const byName = new Map([['StaticPage', folderId]]);
  for (const file of opts.files) {
    const id = newId(file.folder ? 'fold' : 'file');
    const parent = file.parent ? byName.get(file.parent) || folderId : folderId;
    store.set(id, {
      id,
      name: file.name,
      content: file.folder ? null : asBuffer(file.content === undefined ? PAGE : file.content),
      shared: Boolean(file.shared),
      parent,
      modifiedTime: '2026-10-20T10:00:00.000Z',
      mimeType: file.folder ? FOLDER_MIME : (file.mimeType || HTML_MIME)
    });
    if (file.folder) byName.set(file.name, id);
  }
  const state = {
    folderId, folderCreated: false, folderShared: false, store, byName, calls: [],
    get files() { return [...store.values()].filter((f) => f.mimeType !== FOLDER_MIME); },
    get folders() { return [...store.values()].filter((f) => f.mimeType === FOLDER_MIME); },
    byFileName(name) { return [...store.values()].find((f) => f.name === name); }
  };

  await page.route('**/assets/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.STATICPAGE_CONFIG = ${JSON.stringify({
      googleClientId: opts.clientId,
      googleApiKey: opts.apiKey,
      viewerUrl: opts.viewerUrl
    })};`
  }));

  await page.route('https://accounts.google.com/gsi/client', (route) => {
    if (!opts.gisReachable) return route.abort('failed');
    return route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.google = { accounts: { oauth2: { initTokenClient: function (config) {
          window.__gisConfig = config;
          return {
            callback: config.callback,
            error_callback: null,
            // El de verdad abre una ventana emergente, así que solo puede
            // salir de un clic: la cuenta sirve para comprobar que al cargar
            // la página no se pide nada.
            requestAccessToken: function (options) {
              var self = this;
              window.__authRequests = (window.__authRequests || 0) + 1;
              window.__authPrompts = (window.__authPrompts || []).concat([
                options && options.prompt
              ]);
              setTimeout(function () {
                ${opts.authError
                  ? `if (self.error_callback) self.error_callback({ type: ${JSON.stringify(opts.authError)} });`
                  : `self.callback({ access_token: 'fake-token', expires_in: 3600 });`}
              }, 0);
            }
          };
        } } } };`
    });
  });

  const json = (body, status = 200) => ({
    status,
    headers: CORS,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
  const fail = (status, message) => json({ error: { message } }, status);
  const isPublic = (entry) => {
    if (!entry) return false;
    if (entry.shared || (entry.id === folderId && state.folderShared)) return true;
    // Compartir una carpeta comparte lo que tiene dentro, como en Drive.
    const parent = store.get(entry.parent);
    return parent ? isPublic(parent) : false;
  };

  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const headers = request.headers();
    state.calls.push({ method, path, search: url.search, headers });

    const authed = (headers.authorization || '') === 'Bearer fake-token';
    const keyed = url.searchParams.get('key') === opts.apiKey && Boolean(opts.apiKey);

    /* -------- subir y reemplazar -------- */
    if (path.startsWith('/upload/drive/v3/files')) {
      if (opts.failUpload) return route.fulfill(fail(opts.failUpload, 'no se pudo subir'));
      if (!authed) return route.fulfill(fail(401, 'Login Required'));
      const buffer = request.postDataBuffer() || Buffer.alloc(0);

      const target = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (target && method === 'PATCH') {
        const entry = store.get(target[1]);
        if (!entry) return route.fulfill(fail(404, 'File not found'));
        entry.content = buffer;
        entry.replaced = (entry.replaced || 0) + 1;
        entry.modifiedTime = '2026-10-21T10:00:00.000Z';
        entry.uploadType = url.searchParams.get('uploadType');
        return route.fulfill(json({ id: entry.id }));
      }

      const { meta, content } = parseMultipart(buffer, headers['content-type'] || '');
      const id = newId('file');
      store.set(id, {
        id,
        name: meta.name,
        content,
        shared: false,
        parent: (meta.parents || [])[0] || null,
        modifiedTime: '2026-10-20T12:00:00.000Z',
        mimeType: meta.mimeType
      });
      return route.fulfill(json({ id }));
    }

    /* -------- cuota -------- */
    if (path === '/drive/v3/about') {
      if (!authed) return route.fulfill(fail(401, 'Login Required'));
      const q = {};
      if (opts.quota) {
        q.usage = String(opts.quota.usage);
        q.usageInDrive = String(opts.quota.usage);
        if (opts.quota.limit !== null && opts.quota.limit !== undefined) {
          q.limit = String(opts.quota.limit);
        }
      }
      return route.fulfill(json({ storageQuota: q }));
    }

    /* -------- permisos -------- */
    const perm = path.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/(.+))?$/);
    if (perm) {
      if (opts.failPermission) {
        return route.fulfill(fail(opts.failPermission, 'sharing is disabled'));
      }
      if (!authed) return route.fulfill(fail(401, 'Login Required'));
      const id = perm[1];
      const on = method === 'POST';
      if (id === folderId) state.folderShared = on;
      if (store.has(id)) store.get(id).shared = on;
      return method === 'DELETE'
        ? route.fulfill({ status: 204, headers: CORS, body: '' })
        : route.fulfill(json({ id: 'anyoneWithLink' }));
    }

    /* -------- un archivo concreto -------- */
    const one = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one) {
      const id = one[1];
      const file = store.get(id);

      if (method === 'DELETE') {
        if (opts.failDelete) return route.fulfill(fail(opts.failDelete, 'no se pudo borrar'));
        if (!authed) return route.fulfill(fail(401, 'Login Required'));
        const doomed = [id];
        for (const entry of store.values()) if (entry.parent === id) doomed.push(entry.id);
        doomed.forEach((victim) => store.delete(victim));
        return route.fulfill({ status: 204, headers: CORS, body: '' });
      }

      if (url.searchParams.get('alt') === 'media') {
        if (opts.failMedia) return route.fulfill(fail(opts.failMedia, 'no se pudo leer'));
        if (!file) return route.fulfill(fail(404, 'File not found'));
        // Anónimo solo si el archivo es público y la API key es válida.
        if (!authed && !(keyed && isPublic(file))) {
          return route.fulfill(fail(404, 'File not found'));
        }
        return route.fulfill({ headers: CORS, contentType: file.mimeType, body: file.content });
      }
      if (!file) return route.fulfill(fail(404, 'File not found'));
      if (!authed && !(keyed && isPublic(file))) return route.fulfill(fail(404, 'File not found'));
      return route.fulfill(json({
        id: file.id, name: file.name, mimeType: file.mimeType, shared: file.shared
      }));
    }

    /* -------- listar y crear -------- */
    if (path === '/drive/v3/files') {
      if (method === 'POST') {
        if (!authed) return route.fulfill(fail(401, 'Login Required'));
        const meta = request.postDataJSON() || {};
        // La raíz solo se crea una vez; las subcarpetas son entradas nuevas.
        if (meta.name === 'StaticPage' && !meta.parents) {
          state.folderCreated = true;
          if (!store.has(folderId)) {
            store.set(folderId, {
              id: folderId, name: 'StaticPage', parent: null, shared: false, mimeType: FOLDER_MIME
            });
          }
          return route.fulfill(json({ id: folderId }));
        }
        const id = newId('fold');
        store.set(id, {
          id,
          name: meta.name,
          parent: (meta.parents || [])[0] || null,
          shared: false,
          mimeType: meta.mimeType || FOLDER_MIME
        });
        byName.set(meta.name, id);
        return route.fulfill(json({ id }));
      }
      if (opts.failList) return route.fulfill(fail(opts.failList, 'no se pudo listar'));

      const q = url.searchParams.get('q') || '';
      // Búsqueda de la carpeta por nombre
      if (q.includes(FOLDER_MIME) && q.includes("name = 'StaticPage'")) {
        if (!authed) return route.fulfill(fail(401, 'Login Required'));
        if (opts.folderMissing) {
          store.delete(folderId);
          opts.folderMissing = false;
          return route.fulfill(json({ files: [] }));
        }
        if (!store.has(folderId)) return route.fulfill(json({ files: [] }));
        return route.fulfill(json({ files: [{ id: folderId, name: 'StaticPage' }] }));
      }
      // Contenido de una carpeta
      const parent = (q.match(/'([^']+)' in parents/) || [])[1];
      const folder = store.get(parent);
      if (!authed && !(keyed && isPublic(folder))) {
        return route.fulfill(fail(404, 'File not found'));
      }
      const files = [...store.values()]
        .filter((f) => f.parent === parent)
        .map((f) => ({
          id: f.id,
          name: f.name,
          size: f.mimeType === FOLDER_MIME ? undefined : String(f.content.length),
          modifiedTime: f.modifiedTime || '2026-10-20T10:00:00.000Z',
          shared: f.shared,
          mimeType: f.mimeType
        }));
      return route.fulfill(json({ files }));
    }

    return route.fulfill(fail(404, 'endpoint no simulado: ' + method + ' ' + path));
  });

  return state;
}

module.exports = { mockGoogle, PAGE, FOLDER_MIME, HTML_MIME };
