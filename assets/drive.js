/*
 * Google Drive: cada página se guarda en la cuenta de *quien la publica*, así
 * que la cuota es suya y el enlace se reduce a un id de archivo. Basta el scope
 * `drive.file` —acceso por archivo a lo que esta app crea—, que es no sensible
 * y por tanto no necesita verificación de Google.
 *
 * El token de acceso vive en memoria, con una copia en el sessionStorage de la
 * pestaña para que recargar no obligue a otro clic. Pedírselo otra vez a Google
 * al cargar no es opción: su token client responde a `prompt: 'none'` con una
 * ventana emergente, y sin un clic detrás el navegador la bloquea y avisa. La
 * copia va atada a la pestaña y a este client id, y se tira en cuanto caduca o
 * Drive contesta 401. Cerrar la pestaña la borra.
 */
(function (global) {
  'use strict';

  var CONFIG = global.STATICPAGE_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var DRIVE = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
  var FOLDER_NAME = 'StaticPage';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var HTML_MIME = 'text/html';
  // El id de permiso que Drive asigna a «cualquiera con el enlace».
  var ANYONE = 'anyoneWithLink';
  var FIELDS = 'id,name,size,modifiedTime,shared,mimeType';

  var TOKEN_KEY = 'staticpage.drive.token';

  var tokenClient = null;
  var gisLoading = null;

  /* -------------------------------------------------------------- el token */

  // sessionStorage puede no estar (ventana privada, almacenamiento bloqueado):
  // sin él todo sigue igual, solo que recargar vuelve a pedir el botón.
  function box() {
    try { return global.sessionStorage || null; } catch (err) { return null; }
  }

  function readStored() {
    var store = box();
    if (!store) return null;
    var saved = null;
    try { saved = JSON.parse(store.getItem(TOKEN_KEY)); } catch (err) { saved = null; }
    if (!saved || typeof saved.value !== 'string' || typeof saved.expiresAt !== 'number') {
      return null;
    }
    // Otro client id es otro despliegue: su token no sirve aquí.
    if (saved.clientId !== (CONFIG.googleClientId || '')) return null;
    return { value: saved.value, expiresAt: saved.expiresAt };
  }

  function writeStored(entry) {
    var store = box();
    if (!store) return;
    try {
      if (!entry) store.removeItem(TOKEN_KEY);
      else {
        store.setItem(TOKEN_KEY, JSON.stringify({
          value: entry.value,
          expiresAt: entry.expiresAt,
          clientId: CONFIG.googleClientId || ''
        }));
      }
    } catch (err) { /* sin sitio o sin permiso: da igual */ }
  }

  var token = readStored();  // { value, expiresAt }

  function keepToken(value, expiresIn) {
    token = { value: value, expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000 };
    writeStored(token);
    return token.value;
  }

  // Un minuto de margen: no vale un token que caduca a mitad de la petición.
  function liveToken() {
    if (!token) return null;
    if (token.expiresAt > Date.now() + 60000) return token.value;
    forget();
    return null;
  }

  // Para que la vista de carpeta sepa, sin preguntar a Google ni parpadear,
  // si la recarga trae sesión o hay que enseñar el botón.
  function hasSession() { return Boolean(liveToken()); }

  // Publicar necesita el client id; leer una página pública, la API key.
  function canUpload() { return Boolean(CONFIG.googleClientId); }
  function canRead() { return Boolean(CONFIG.googleApiKey); }

  // Publicar solo tiene sentido si este despliegue sabe servir lo publicado:
  // un enlace que el visor no puede abrir es peor que ningún enlace.
  function canPublish() { return canUpload() && canRead(); }

  function isFileId(id) { return typeof id === 'string' && FILE_ID.test(id); }

  function fileUrl(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }

  function loadGis() {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) {
      return Promise.resolve();
    }
    if (!gisLoading) {
      gisLoading = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = GIS_SRC;
        script.async = true;
        script.onload = resolve;
        script.onerror = function () {
          gisLoading = null;
          reject(new Error('gis-unreachable'));
        };
        document.head.appendChild(script);
      });
    }
    return gisLoading;
  }

  // `interactive` a false reutiliza un token vivo y nunca abre la ventana, así
  // que la interfaz distingue «ya conectado» de «hace falta un clic».
  function getToken(interactive) {
    var live = liveToken();
    if (live) return Promise.resolve(live);
    if (!interactive) return Promise.resolve(null);
    return requestToken();
  }

  // Siempre detrás de un clic: el token client abre una ventana emergente, y
  // sin gesto del usuario el navegador la bloquea y saca su aviso.
  function requestToken() {
    if (!canUpload()) return Promise.reject(new Error('not-configured'));

    return loadGis().then(function () {
      if (!tokenClient) {
        tokenClient = global.google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.googleClientId,
          scope: SCOPE,
          callback: function () {}
        });
      }
      return new Promise(function (resolve, reject) {
        tokenClient.callback = function (response) {
          if (!response || response.error) {
            return reject(new Error((response && response.error) || 'auth-failed'));
          }
          resolve(keepToken(response.access_token, response.expires_in));
        };
        tokenClient.error_callback = function (err) {
          reject(new Error((err && err.type) || 'auth-cancelled'));
        };
        // Un prompt vacío reutiliza el consentimiento si ya existe.
        tokenClient.requestAccessToken({ prompt: '' });
      });
    });
  }

  function forget() {
    token = null;
    writeStored(null);
  }

  function apiError(response, body) {
    // Un 401 es un token muerto (caducado o revocado). Si se quedara guardado,
    // recargar y hasta volver a pulsar el botón repetirían el mismo fallo.
    if (response.status === 401) forget();
    var detail = body && body.error && body.error.message;
    var err = new Error(detail || ('HTTP ' + response.status));
    err.status = response.status;
    return err;
  }

  function readJson(response) {
    return response.json().catch(function () { return null; });
  }

  /* ---------------------------------------------------------------- subir */

  // Una sola petición multipart/related: metadatos y contenido. El contenido va
  // como Blob, con sus bytes tal cual: una página en windows-1252 tiene que
  // llegar a Drive igual que salió del disco.
  function upload(name, content, parentId) {
    return getToken(true).then(function (accessToken) {
      var boundary = 'staticpage-' + Math.random().toString(36).slice(2);
      var metadata = { name: name || 'pagina.html', mimeType: HTML_MIME };
      if (isFileId(parentId)) metadata.parents = [parentId];
      var body = new Blob([
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: ' + HTML_MIME + '\r\n\r\n',
        content,
        '\r\n--' + boundary + '--'
      ]);

      return fetch(UPLOAD + '?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'multipart/related; boundary=' + boundary
        },
        body: body
      }).then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          if (!json || !isFileId(json.id)) throw new Error('bad-response');
          return json.id;
        });
      });
    });
  }

  // Cambiar el contenido sin cambiar el archivo: el id —y con él el enlace que
  // ya circula— sigue siendo el mismo, y también sus permisos.
  function replace(fileId, content) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return getToken(true).then(function (accessToken) {
      return fetch(UPLOAD + '/' + fileId + '?uploadType=media&fields=id', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': HTML_MIME
        },
        body: content instanceof Blob ? content : new Blob([content])
      }).then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          return fileId;
        });
      });
    });
  }

  // «Cualquiera con el enlace puede leer»: el id del archivo pasa a ser la llave.
  function publish(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return getToken(true).then(function (accessToken) {
      return fetch(DRIVE + '/files/' + fileId + '/permissions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      }).then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) {
            var err = apiError(response, json);
            // Las cuentas de Workspace suelen prohibir compartir fuera de la organización.
            if (response.status === 403) err.code = 'sharing-blocked';
            throw err;
          }
          return true;
        });
      });
    });
  }

  /* ------------------------------------------------------------- la carpeta */

  // Una petición autenticada cualquiera. El scope drive.file limita todo esto a
  // lo que la propia app creó, así que no hace falta filtrar por nada más.
  function api(path, options) {
    return getToken(true).then(function (accessToken) {
      var opts = options || {};
      var headers = { Authorization: 'Bearer ' + accessToken };
      if (opts.json) headers['Content-Type'] = 'application/json';
      return fetch(DRIVE + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.json ? JSON.stringify(opts.json) : undefined
      }).then(function (response) {
        if (response.status === 204) return null;
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          return json;
        });
      });
    });
  }

  function query(q, fields) {
    return '?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(' + (fields || FIELDS) + ')') +
      '&orderBy=folder,modifiedTime desc&pageSize=200';
  }

  // La carpeta «StaticPage» del Drive del usuario. Con el scope drive.file la
  // búsqueda solo ve carpetas que esta app creó, así que no puede colarse otra
  // carpeta del usuario que se llame igual.
  function ensureFolder() {
    var q = "name = '" + FOLDER_NAME + "' and mimeType = '" + FOLDER_MIME +
      "' and trashed = false";
    return api('/files' + query(q, 'id,name')).then(function (json) {
      var found = json && json.files && json.files[0];
      if (found && isFileId(found.id)) return found.id;
      return api('/files?fields=id', {
        method: 'POST',
        json: { name: FOLDER_NAME, mimeType: FOLDER_MIME }
      }).then(function (created) {
        if (!created || !isFileId(created.id)) throw new Error('bad-response');
        return created.id;
      });
    });
  }

  // Una subcarpeta dentro de la que se esté viendo. También la crea esta app,
  // así que el scope drive.file la alcanza igual que a la raíz.
  function createFolder(name, parentId) {
    var metadata = { name: name || 'Nueva carpeta', mimeType: FOLDER_MIME };
    if (isFileId(parentId)) metadata.parents = [parentId];
    return api('/files?fields=id', { method: 'POST', json: metadata })
      .then(function (created) {
        if (!created || !isFileId(created.id)) throw new Error('bad-response');
        return created.id;
      });
  }

  // Nombre de una carpeta a la que se entra por enlace directo, para el rastro
  // de migas: navegando se conoce, pero al abrir /account/?id=… no.
  function meta(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return api('/files/' + fileId + '?fields=id,name,mimeType,shared');
  }

  function isFolder(item) { return Boolean(item) && item.mimeType === FOLDER_MIME; }

  function listFolder(folderId) {
    if (!isFileId(folderId)) return Promise.reject(new Error('bad-id'));
    var q = "'" + folderId + "' in parents and trashed = false";
    return api('/files' + query(q)).then(function (json) {
      return (json && json.files) || [];
    });
  }

  // Los bytes, no el texto: la codificación la decide StaticPage.decode().
  function bytesOf(response) {
    if (!response.ok) {
      return readJson(response).then(function (json) { throw apiError(response, json); });
    }
    return response.arrayBuffer();
  }

  // Lectura con sesión: no depende de que la página sea pública.
  function fetchOwn(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return getToken(true).then(function (accessToken) {
      return fetch(DRIVE + '/files/' + fileId + '?alt=media', {
        headers: { Authorization: 'Bearer ' + accessToken }
      }).then(bytesOf);
    });
  }

  function remove(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return api('/files/' + fileId, { method: 'DELETE' }).then(function () { return true; });
  }

  function unpublish(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return api('/files/' + fileId + '/permissions/' + ANYONE, { method: 'DELETE' })
      .then(function () { return false; });
  }

  // Espacio de la cuenta. `limit` no viene en cuentas sin tope.
  function quota() {
    return api('/about?fields=storageQuota').then(function (json) {
      var q = (json && json.storageQuota) || {};
      return {
        usage: Number(q.usage) || 0,
        usageInDrive: Number(q.usageInDrive) || 0,
        limit: q.limit === undefined ? null : Number(q.limit)
      };
    });
  }

  /* ------------------------------------------------------- lectura anónima */

  function keyed(path) {
    return DRIVE + path + (path.indexOf('?') === -1 ? '?' : '&') +
      'key=' + encodeURIComponent(CONFIG.googleApiKey);
  }

  // Listado de una carpeta pública, con API key y sin sesión. Descansa en lo
  // mismo que la lectura anónima de un archivo: que la Drive API conteste con
  // cabeceras CORS. Sin confirmar todavía contra Google para carpetas.
  function listPublic(folderId) {
    if (!isFileId(folderId)) return Promise.reject(new Error('bad-id'));
    if (!canRead()) return Promise.reject(new Error('not-configured'));
    var q = "'" + folderId + "' in parents and trashed = false";
    return fetch(keyed('/files' + query(q))).then(function (response) {
      return readJson(response).then(function (json) {
        if (!response.ok) throw apiError(response, json);
        return (json && json.files) || [];
      });
    });
  }

  // El visor: sin sesión y sin token. Funciona porque la página ya es pública y
  // la Drive API responde a peticiones de otro origen que llevan API key.
  // `maxBytes` corta antes de descargar un archivo enorme que alguien haya
  // enlazado como si fuera una página.
  function download(fileId, maxBytes) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    if (!canRead()) return Promise.reject(new Error('not-configured'));
    return fetch(keyed('/files/' + fileId + '?alt=media')).then(function (response) {
      var length = Number(response.headers.get('content-length'));
      if (response.ok && maxBytes && length > maxBytes) {
        if (response.body && response.body.cancel) response.body.cancel().catch(function () {});
        throw new Error('too-big');
      }
      return bytesOf(response);
    }).then(function (buffer) {
      // Sin Content-Length no hay aviso previo, pero el tope se cumple igual.
      if (maxBytes && buffer.byteLength > maxBytes) throw new Error('too-big');
      return buffer;
    });
  }

  global.StaticPageDrive = {
    canUpload: canUpload,
    canRead: canRead,
    canPublish: canPublish,
    isFileId: isFileId,
    fileUrl: fileUrl,
    getToken: getToken,
    hasSession: hasSession,
    forget: forget,
    upload: upload,
    replace: replace,
    publish: publish,
    unpublish: unpublish,
    download: download,
    ensureFolder: ensureFolder,
    createFolder: createFolder,
    isFolder: isFolder,
    meta: meta,
    listFolder: listFolder,
    listPublic: listPublic,
    fetchOwn: fetchOwn,
    remove: remove,
    quota: quota,
    folderName: FOLDER_NAME
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
