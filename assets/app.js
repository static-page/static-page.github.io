/*
 * La portada y el visor, en la misma página.
 *
 *   /                portada: qué es esto y el camino a la carpeta
 *   /?p=<fileId>     visor: trae de Drive el HTML de esa página pública y lo
 *                    pone en lugar de este documento, entero
 *
 * El visor no usa un <iframe>: la página publicada pasa a ser el documento, con
 * su <title>, sus scripts, su localStorage y la URL de este sitio. A cambio se
 * ejecuta en este origen, y por eso antes de escribirla se retira de la pestaña
 * todo lo que no debe ver (ver README, «Seguridad»).
 */
(function () {
  'use strict';

  var Drive = self.StaticPageDrive;
  var P = self.StaticPage;

  // Lo que este script deja en el global. La página publicada empieza sin ello:
  // nada que pisar ni que leer.
  var OURS = ['StaticPage', 'StaticPageDrive', 'StaticPageTheme', 'STATICPAGE_CONFIG'];

  function queryParams() {
    var params = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
    });
    return params;
  }

  /* ------------------------------------------------------------------ visor */

  function startViewer(raw) {
    var viewer = document.getElementById('viewer');
    var msg = document.getElementById('viewerMsg');
    var id;
    try { id = decodeURIComponent(raw); } catch (err) { id = ''; }

    viewer.hidden = false;
    document.title = 'Cargando… · StaticPage';

    function fail(message, driveId) {
      document.title = 'StaticPage';
      document.getElementById('viewerSpinner').hidden = true;
      msg.textContent = message;
      document.getElementById('viewerLinks').hidden = false;
      // Si la lectura falla, puede que el archivo siga accesible desde Drive:
      // mejor esa puerta que un callejón sin salida.
      if (driveId) {
        var link = document.getElementById('viewerDrive');
        link.href = Drive.fileUrl(driveId);
        link.hidden = false;
      }
    }

    if (!Drive.isFileId(id)) return fail('El enlace está dañado o incompleto.');
    if (!Drive.canRead()) {
      return fail('Este StaticPage no tiene configurada la lectura de Google Drive.');
    }

    Drive.download(id, P.MAX_BYTES).then(function (buffer) {
      if (!buffer.byteLength) throw new Error('empty');
      if (P.looksBinary(buffer)) throw new Error('not-html');
      var html = P.decode(buffer);
      return loaded().then(function () { show(html); });
    }).catch(function (err) {
      var code = err && err.message;
      if (code === 'too-big') {
        fail('Esta página pesa más de ' + P.formatBytes(P.MAX_BYTES) + ', el máximo que abre el visor.', id);
      } else if (code === 'not-html') {
        fail('Ese archivo de Drive no es una página HTML.', id);
      } else if (code === 'empty') {
        fail('La página está vacía.', id);
      } else {
        fail('No se pudo cargar la página desde Google Drive. Puede que ya no exista ' +
          'o que haya dejado de ser pública.', id);
      }
    });
  }

  // document.open() sobre un documento que aún carga lo abortaría a medias:
  // se espera a que este haya terminado del todo.
  function loaded() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      window.addEventListener('load', function () { resolve(); }, { once: true });
    });
  }

  function show(html) {
    // La página se ejecuta en este origen: si esta pestaña venía de la carpeta,
    // el token de Drive no se queda a su alcance en sessionStorage.
    Drive.forget();
    OURS.forEach(function (name) {
      try { delete self[name]; } catch (err) { self[name] = undefined; }
    });
    P.replaceDocument(html);
  }

  /* ---------------------------------------------------------------- portada */

  function startLanding() {
    var ready = Drive.canPublish();
    document.getElementById('landing').hidden = false;
    document.getElementById('ctaBox').hidden = !ready;
    document.getElementById('accountLink').hidden = !ready;
    document.getElementById('offBox').hidden = ready;
  }

  /* -------------------------------------------------------------- arranque */

  var params = queryParams();
  if (params.p !== undefined) startViewer(params.p);
  else startLanding();
})();
