/*
 * Vista de carpeta: las páginas que el usuario guarda en su propio Google
 * Drive, dentro de una carpeta «StaticPage» que esta app crea y es la única
 * que ve.
 *
 * Dos modos:
 *   /account/            mi carpeta, requiere iniciar sesión
 *   /account/?f=<id>     una carpeta compartida, anónima y de solo lectura
 *
 * El scope sigue siendo `drive.file`: acceso por archivo a lo que la propia app
 * crea. No puede ver el resto del Drive del usuario ni sabe de qué cuenta se
 * trata — no se piden `email` ni `profile` para no salir del scope no sensible.
 */
(function () {
  'use strict';

  var Drive = self.StaticPageDrive;
  var P = self.StaticPage;
  var CONFIG = self.STATICPAGE_CONFIG || {};

  var rootId = null;    // la carpeta StaticPage
  var folderId = null;  // la que se está viendo (puede ser una subcarpeta)
  var trail = [];       // rastro de migas: [{ id, name }]
  var items = [];
  var sharing = null;   // { id, kind: 'file' | 'folder', name }
  var previewing = null; // la página que enseña la modal, mientras está abierta
  var previewTurn = 0;  // descarta respuestas de una vista previa anterior
  var readPublic = false;

  /* ------------------------------------------------------------------ toast */

  var toastEl = document.getElementById('toast');
  var toastTimer;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2400);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) { /* sigue abajo */ }
    var helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(helper);
    helper.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(helper);
    return ok;
  }

  // Los errores de Google son para quien programa; estos son accionables.
  function driveMessage(err) {
    var code = err && (err.code || err.message);
    if (code === 'auth-cancelled' || code === 'popup_closed' || code === 'popup_failed_to_open') {
      return 'Se canceló el acceso a Google Drive';
    }
    if (code === 'gis-unreachable') return 'No se pudo contactar con Google';
    if (code === 'not-configured') return 'Este StaticPage no tiene configurado Google Drive';
    if (code === 'sharing-blocked') return 'Tu cuenta no permite compartir fuera de la organización';
    if (err && err.status === 401) return 'La sesión de Google caducó, inténtalo otra vez';
    if (err && err.status === 403) return 'Google rechazó la operación: ' + err.message;
    return 'Algo falló con Drive' + (err && err.message ? ': ' + err.message : '');
  }

  /* ------------------------------------------------------------------- url */

  function baseUrl() {
    return location.origin + location.pathname.replace(/account\/(index\.html)?$/, '');
  }

  // Dónde se abren las páginas: este mismo sitio, o el origen aparte que diga
  // la configuración (ver README, «Seguridad»).
  function viewerBase() {
    var url = String(CONFIG.viewerUrl || '').trim();
    if (!/^https?:\/\/[^/]/i.test(url)) return baseUrl();
    return /\/$|\.html?$/i.test(url) ? url : url + '/';
  }

  function pageLink(id) {
    return viewerBase() + '?p=' + encodeURIComponent(id);
  }

  function folderLink(id) {
    return baseUrl() + 'account/?f=' + encodeURIComponent(id);
  }

  // Navegación por carpetas propias: ?id= para que atrás y recargar funcionen.
  function ownLink(id) {
    return id && id !== rootId ? baseUrl() + 'account/?id=' + encodeURIComponent(id)
      : baseUrl() + 'account/';
  }

  function queryParams() {
    var params = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq <= 0) return;
      try { params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1)); } catch (err) { /* fuera */ }
    });
    return params;
  }

  /* ------------------------------------------------------------------ vista */

  var pageList = document.getElementById('pages');
  var folderList = document.getElementById('folders');
  var emptyNote = document.getElementById('emptyNote');
  var addZone = document.getElementById('addZone');
  var folderBox = document.getElementById('folderBox');
  var signinBox = document.getElementById('signinBox');

  function show(el, on) { el.hidden = !on; }

  var FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';

  var PAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>' +
    '<path d="m10 12-2 2 2 2M14 12l2 2-2 2"/></svg>';

  var SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/>' +
    '<circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>';

  function badge(text) {
    var el = document.createElement('span');
    el.className = 'row-meta';
    el.textContent = text;
    return el;
  }

  // Una carpeta: la fila entera es la puerta, sin acciones sueltas.
  function folderRow(item) {
    var li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = item.id;

    var open = document.createElement('a');
    open.className = 'row-open';
    open.href = readPublic ? folderLink(item.id) : ownLink(item.id);
    open.innerHTML = FOLDER_ICON;

    var name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = item.name;
    name.title = item.name;
    open.appendChild(name);
    if (item.shared && !readPublic) open.appendChild(badge('compartida'));

    if (!readPublic) {
      open.addEventListener('click', function (event) {
        event.preventDefault();
        enterFolder(item.id, item.name);
      });
    }
    li.appendChild(open);
    return li;
  }

  // Una página: el clic la abre en la vista previa, sin salir de la carpeta.
  // El enlace al visor se mantiene para abrir en otra pestaña o copiarlo.
  function pageRow(item) {
    var li = document.createElement('li');
    li.className = 'row page-row';
    li.dataset.id = item.id;

    var open = document.createElement('a');
    open.className = 'row-open';
    open.href = pageLink(item.id);
    open.innerHTML = PAGE_ICON;

    var text = document.createElement('span');
    text.className = 'row-text';
    var name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = item.name;
    name.title = item.name;
    var sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = describe(item);
    text.appendChild(name);
    text.appendChild(sub);
    open.appendChild(text);

    if (readPublic) {
      li.appendChild(open);
      return li;
    }

    if (item.shared) open.appendChild(badge('pública'));
    // El visor está en este mismo origen: abrirlo nunca hereda esta pestaña.
    open.target = '_blank';
    open.rel = 'noopener';
    open.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openPreview(item);
    });

    var share = document.createElement('button');
    share.type = 'button';
    share.className = 'icon-btn row-share';
    share.title = item.shared ? 'Ver el enlace' : 'Compartir';
    share.setAttribute('aria-label', (item.shared ? 'Ver el enlace de «' : 'Compartir «') + item.name + '»');
    share.innerHTML = SHARE_ICON;
    share.addEventListener('click', function () { openShare(item, 'file'); });

    li.appendChild(open);
    li.appendChild(share);
    return li;
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function describe(item) {
    return [
      item.size ? P.formatBytes(Number(item.size)) : null,
      item.modifiedTime ? formatDate(item.modifiedTime) : null
    ].filter(Boolean).join(' · ');
  }

  function pagesHere() {
    return items.filter(function (x) { return !Drive.isFolder(x); });
  }

  function render() {
    pageList.textContent = '';
    folderList.textContent = '';

    var byName = function (a, b) { return a.name.localeCompare(b.name, 'es'); };
    var folders = items.filter(Drive.isFolder).sort(byName);
    var pages = pagesHere().sort(byName);

    folders.forEach(function (item) { folderList.appendChild(folderRow(item)); });
    pages.forEach(function (item) { pageList.appendChild(pageRow(item)); });

    addZone.hidden = readPublic;
    // En la vista propia el hueco de añadir ya dice que está vacío.
    show(emptyNote, items.length === 0 && readPublic);
    renderCrumbs();
    renderHead();
  }

  // La cabecera nombra la carpeta en la que se está.
  function renderHead() {
    var here = currentName();
    document.getElementById('folderName').textContent = here;
    document.getElementById('dangerNote').textContent = folderId === rootId
      ? 'Borra la carpeta «' + here + '» y todas sus páginas. Se vuelve a crear vacía la próxima vez que entres.'
      : 'Borra la carpeta «' + here + '» y todo lo que hay dentro. No se puede deshacer.';
  }

  function currentName() {
    return trail.length ? trail[trail.length - 1].name : Drive.folderName;
  }

  // El rastro solo aparece cuando se ha bajado de la raíz.
  function renderCrumbs() {
    var box = document.getElementById('crumbs');
    box.textContent = '';
    if (readPublic || trail.length < 2) { box.hidden = true; return; }

    trail.forEach(function (step, i) {
      if (i) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        box.appendChild(sep);
      }
      if (i === trail.length - 1) {
        var here = document.createElement('span');
        here.className = 'here';
        here.textContent = step.name;
        box.appendChild(here);
      } else {
        var link = document.createElement('a');
        link.href = ownLink(step.id);
        link.textContent = step.name;
        link.addEventListener('click', function (event) {
          event.preventDefault();
          goTo(i);
        });
        box.appendChild(link);
      }
    });
    box.hidden = false;
  }

  /* ------------------------------------------------------------------ cuota */

  function renderQuota(q) {
    var box = document.getElementById('quotaBox');
    if (!q || q.limit === null) {
      // Cuentas sin tope: la barra no diría nada.
      document.getElementById('quotaFigure').textContent = P.formatBytes(q ? q.usage : 0) + ' en uso';
      document.getElementById('quotaFill').style.width = '0%';
      document.getElementById('quotaNote').textContent = 'Esta cuenta no tiene límite de espacio.';
      show(box, true);
      return;
    }
    var pct = q.limit > 0 ? Math.min(100, (q.usage / q.limit) * 100) : 0;
    var level = pct < 75 ? 'ok' : pct < 90 ? 'warn' : 'bad';
    document.getElementById('quotaFigure').textContent =
      P.formatBytes(q.usage) + ' de ' + P.formatBytes(q.limit);
    var fill = document.getElementById('quotaFill');
    fill.style.width = pct.toFixed(1) + '%';
    fill.style.background = 'var(--' + level + ')';
    document.getElementById('quotaNote').textContent = pct >= 90
      ? 'Tu Drive está casi lleno: puede que las subidas empiecen a fallar.'
      : Math.round(pct) + '% del espacio de tu cuenta de Google.';
    show(box, true);
  }

  /* -------------------------------------------------------------- diálogos */

  var shareDialog = document.getElementById('shareDialog');
  var previewDialog = document.getElementById('previewDialog');
  var pasteDialog = document.getElementById('pasteDialog');
  var askDialog = document.getElementById('askDialog');
  var askInput = document.getElementById('askInput');
  var askError = document.getElementById('askError');
  var asking = null;    // { input, resolve } mientras hay una pregunta abierta

  function openDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  // Preguntar sin salir de la página. Devuelve el texto —o true— al aceptar, y
  // null —o false— al cancelar.
  function ask(options) {
    var opts = options || {};
    var note = document.getElementById('askNote');
    var field = document.getElementById('askField');
    var ok = document.getElementById('btnAskOk');

    document.getElementById('askTitle').textContent = opts.title || 'Confirmar';
    note.textContent = opts.note || '';
    note.hidden = !opts.note;
    field.hidden = !opts.input;
    if (opts.input) {
      document.getElementById('askLabel').textContent = opts.label || 'Nombre';
      askInput.value = opts.value || '';
      askInput.placeholder = opts.placeholder || '';
    }
    askError.hidden = true;
    ok.textContent = opts.okText || 'Aceptar';
    ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');

    // returnValue se conserva entre aperturas: sin esto, un «sí» de antes
    // valdría como respuesta a la pregunta siguiente.
    askDialog.returnValue = '';
    openDialog(askDialog);
    if (opts.input) askInput.select();

    return new Promise(function (resolve) {
      asking = { input: Boolean(opts.input), resolve: resolve };
    });
  }

  document.getElementById('askForm').addEventListener('submit', function (event) {
    if (!asking || !asking.input || askInput.value.trim()) return;
    // Sin nombre no hay nada que crear: la pregunta se queda abierta.
    event.preventDefault();
    askError.textContent = 'Hace falta un nombre';
    askError.hidden = false;
    askInput.focus();
  });

  // Cerrar por donde sea —✕, Cancelar, Escape— pasa por aquí.
  askDialog.addEventListener('close', function () {
    if (!asking) return;
    var answer = asking.resolve;
    var wanted = asking.input;
    var yes = askDialog.returnValue === 'ok';
    asking = null;
    answer(wanted ? (yes ? askInput.value.trim() : null) : yes);
  });

  // Al cerrar la vista previa, fuera el marco: una página cerrada no tiene por
  // qué seguir ejecutando scripts ni sonando.
  previewDialog.addEventListener('close', function () {
    previewing = null;
    previewTurn++;
    clearStage();
  });

  // La ✕, el botón de cancelar, y el clic en el telón: el <dialog> solo recibe
  // el clic cuando cae fuera de su contenido.
  [shareDialog, previewDialog, pasteDialog, askDialog].forEach(function (dialog) {
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog || event.target.closest('[data-close-dialog]')) dialog.close();
    });
  });

  /* ------------------------------------------------------------ compartir */

  function openShare(item, kind) {
    sharing = { id: item.id, kind: kind, name: item.name };
    var isFolder = kind === 'folder';
    var linkEl = document.getElementById('shareLink');
    var openEl = document.getElementById('btnShareOpen');
    document.getElementById('shareTitle').textContent =
      isFolder ? 'Compartir la carpeta' : 'Compartir «' + item.name + '»';
    document.getElementById('shareNote').textContent = isFolder
      ? 'Cualquiera con este enlace podrá ver la lista de páginas de la carpeta y abrirlas, pero no añadir ni borrar nada.'
      : 'Cualquiera con este enlace podrá ver la página. Si la reemplazas, el enlace sigue siendo el mismo.';
    linkEl.value = 'Preparando…';
    openEl.removeAttribute('href');
    openDialog(shareDialog);

    Drive.publish(item.id).then(function () {
      var link = isFolder ? folderLink(item.id) : pageLink(item.id);
      linkEl.value = link;
      openEl.href = link;
      item.shared = true;
      if (!isFolder) refreshRow(item);
    }).catch(function (err) {
      linkEl.value = '';
      toast(driveMessage(err));
      shareDialog.close();
    });
  }

  // Compartir o dejar de compartir cambia lo que dice la fila, y no merece
  // volver a listar la carpeta entera.
  function refreshRow(item) {
    var li = document.querySelector('#pages [data-id="' + item.id + '"]');
    if (!li) return;
    li.replaceWith(pageRow(item));
  }

  /* ---------------------------------------------------------- vista previa */

  var stage = document.getElementById('previewStage');
  var stageStatus = document.getElementById('previewStatus');

  function clearStage() {
    var frame = stage.querySelector('iframe');
    if (frame) frame.remove();
  }

  // Ver la página sin salir de la carpeta. Aislada en un origen opaco: aquí al
  // lado vive el token de Drive.
  function openPreview(item) {
    previewing = item;
    document.getElementById('previewTitle').textContent = item.name;
    syncPreview(item);
    openDialog(previewDialog);
    loadPreview(item);
  }

  function syncPreview(item) {
    document.getElementById('previewMeta').textContent = describe(item);
    var open = document.getElementById('btnPreviewOpen');
    // El visor solo abre páginas públicas: sin compartir, el enlace no llevaría a nada.
    open.hidden = !item.shared;
    open.href = pageLink(item.id);
  }

  function loadPreview(item) {
    var turn = ++previewTurn;
    clearStage();
    stageStatus.textContent = 'Cargando…';
    stageStatus.hidden = false;

    Drive.fetchOwn(item.id).then(function (buffer) {
      if (turn !== previewTurn) return;
      stageStatus.hidden = true;
      stage.appendChild(P.previewFrame(P.decode(buffer), item.name));
    }).catch(function (err) {
      if (turn !== previewTurn) return;
      stageStatus.textContent = 'No se pudo cargar la página. ' + driveMessage(err);
    });
  }

  /* ---------------------------------------------------------------- guardar */

  // Filtra lo que no es una página o pasa del tope, avisando de cada cosa.
  function acceptable(files) {
    return Array.prototype.slice.call(files).filter(function (file) {
      if (!P.isHtmlFile(file)) toast('«' + file.name + '» no es una página HTML');
      else if (file.size > P.MAX_BYTES) toast('«' + file.name + '» pasa de ' + P.formatBytes(P.MAX_BYTES));
      else return true;
      return false;
    });
  }

  // Guardar con un nombre que ya existe en la carpeta es casi siempre subir la
  // versión nueva: se ofrece reemplazar, que conserva el enlace. Devuelve
  // 'created', 'replaced' o null si se dejó estar.
  function store(name, content) {
    var existing = pagesHere().filter(function (x) { return x.name === name; })[0];
    if (!existing) {
      return Drive.upload(name, content, folderId).then(function () { return 'created'; });
    }
    return ask({
      title: 'Ya existe «' + name + '»',
      note: '¿Reemplazar su contenido por el nuevo? El enlace' +
        (existing.shared ? ', que ya es público,' : '') + ' no cambia.',
      okText: 'Reemplazar'
    }).then(function (yes) {
      if (!yes) return null;
      return Drive.replace(existing.id, content).then(function () { return 'replaced'; });
    });
  }

  function uploadFiles(files) {
    var list = acceptable(files);
    if (!list.length) return;

    toast(list.length === 1 ? 'Subiendo…' : 'Subiendo ' + list.length + ' archivos…');
    var done = 0;
    // En serie: son subidas del usuario, no hay prisa, y así un fallo no deja
    // media docena de peticiones colgando. Y cada pregunta de reemplazar llega
    // de una en una.
    list.reduce(function (chain, file) {
      return chain.then(function () {
        return store(P.htmlName(file.name), file).then(function (result) {
          if (result) done++;
        });
      });
    }, Promise.resolve()).then(function () {
      if (done) toast('Listo');
      return reload();
    }).catch(function (err) {
      toast(driveMessage(err));
      return reload();
    });
  }

  // Cambiar el contenido de la página abierta en la vista previa.
  function replaceCurrent(file) {
    var item = previewing;
    if (!item || !file) return;
    if (!acceptable([file]).length) return;

    toast('Reemplazando…');
    Drive.replace(item.id, file).then(function () {
      toast('Página reemplazada: el enlace no cambia');
      return reload().then(function () {
        var fresh = items.filter(function (x) { return x.id === item.id; })[0];
        if (fresh && previewing && previewing.id === item.id) {
          previewing = fresh;
          syncPreview(fresh);
          loadPreview(fresh);
        }
      });
    }).catch(function (err) { toast(driveMessage(err)); });
  }

  function openPaste() {
    document.getElementById('pasteName').value = '';
    document.getElementById('pasteCode').value = '';
    document.getElementById('pasteError').hidden = true;
    pasteDialog.returnValue = '';
    openDialog(pasteDialog);
    document.getElementById('pasteCode').focus();
  }

  document.getElementById('pasteForm').addEventListener('submit', function (event) {
    var code = document.getElementById('pasteCode').value;
    var error = document.getElementById('pasteError');
    event.preventDefault();
    if (!code.trim()) {
      error.textContent = 'Falta el código de la página';
      error.hidden = false;
      document.getElementById('pasteCode').focus();
      return;
    }
    var blob = new Blob([code], { type: P.MIME });
    if (blob.size > P.MAX_BYTES) {
      error.textContent = 'La página pasa de ' + P.formatBytes(P.MAX_BYTES);
      error.hidden = false;
      return;
    }
    // Sin nombre se toma el <title> de la propia página.
    var typed = document.getElementById('pasteName').value;
    var name = P.htmlName(typed.trim() ? typed : P.titleOf(code));
    pasteDialog.close();

    store(name, blob).then(function (result) {
      if (result === 'created') toast('Página creada');
      else if (result === 'replaced') toast('Página reemplazada: el enlace no cambia');
      return reload();
    }).catch(function (err) { toast(driveMessage(err)); });
  });

  // Solo páginas: una carpeta se borra desde dentro, en la zona de riesgo.
  function removeItem(item) {
    ask({
      title: 'Borrar la página',
      note: '¿Borrar «' + item.name + '» de tu Drive? Su enlace dejará de funcionar. No se puede deshacer.',
      okText: 'Borrar',
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      return Drive.remove(item.id).then(function () {
        items = items.filter(function (x) { return x.id !== item.id; });
        render();
        toast('Borrada');
        Drive.quota().then(renderQuota).catch(function () {});
      });
    }).catch(function (err) { toast(driveMessage(err)); });
  }

  function reload() {
    return Drive.listFolder(folderId).then(function (files) {
      items = files;
      render();
      return Drive.quota().then(renderQuota).catch(function () {});
    });
  }

  /* ---------------------------------------------------------- navegación */

  function enterFolder(id, name) {
    folderId = id;
    trail.push({ id: id, name: name });
    history.pushState({ id: id }, '', ownLink(id));
    items = [];
    render();
    reload().catch(function (err) { toast(driveMessage(err)); });
  }

  // Volver a un punto del rastro: se recorta y se recarga.
  function goTo(index) {
    trail = trail.slice(0, index + 1);
    folderId = trail[trail.length - 1].id;
    history.pushState({ id: folderId }, '', ownLink(folderId));
    items = [];
    render();
    reload().catch(function (err) { toast(driveMessage(err)); });
  }

  // El botón «atrás» del navegador tiene que funcionar dentro de la carpeta.
  window.addEventListener('popstate', function () {
    if (readPublic || !rootId) return;
    var target = queryParams().id || rootId;
    var known = trail.map(function (step) { return step.id; }).indexOf(target);
    if (known !== -1) {
      trail = trail.slice(0, known + 1);
      folderId = target;
      items = [];
      render();
      reload().catch(function () {});
    } else {
      openFolder(target);
    }
  });

  // Abrir una carpeta por su id, sin rastro previo (enlace directo o «atrás»
  // a un punto que ya no está en el rastro).
  function openFolder(id) {
    folderId = id;
    items = [];
    if (id === rootId) {
      trail = [{ id: rootId, name: Drive.folderName }];
      render();
      return reload().catch(function (err) { toast(driveMessage(err)); });
    }
    return Drive.meta(id).then(function (info) {
      trail = [{ id: rootId, name: Drive.folderName }, { id: id, name: info.name }];
      render();
      return reload();
    }).catch(function (err) {
      toast(driveMessage(err));
      folderId = rootId;
      trail = [{ id: rootId, name: Drive.folderName }];
      return reload().catch(function () {});
    });
  }

  // La carpeta que se está viendo. Al borrarla hay que salir de ella: si era la
  // raíz, ensureFolder la vuelve a crear vacía.
  function deleteCurrentFolder() {
    var here = currentName();
    var wasRoot = folderId === rootId;

    // Borrar una carpeta en Drive se lleva por delante lo que hay dentro, así
    // que la pregunta tiene que decirlo.
    ask({
      title: 'Borrar la carpeta',
      note: '¿Borrar la carpeta «' + here + '» y todo su contenido? Los enlaces de sus páginas dejarán de funcionar. No se puede deshacer.',
      okText: 'Borrar',
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      return removeFolder(wasRoot);
    }).catch(function (err) { toast(driveMessage(err)); });
  }

  function removeFolder(wasRoot) {
    return Drive.remove(folderId).then(function () {
      toast('Carpeta borrada');
      if (wasRoot) {
        return Drive.ensureFolder().then(function (id) {
          rootId = id;
          history.replaceState({ id: id }, '', ownLink(id));
          return openFolder(id);
        });
      }
      trail = trail.slice(0, -1);
      var parent = trail.length ? trail[trail.length - 1].id : rootId;
      history.pushState({ id: parent }, '', ownLink(parent));
      folderId = parent;
      items = [];
      render();
      return reload();
    });
  }

  function newFolder() {
    ask({
      title: 'Nueva carpeta',
      label: 'Nombre de la carpeta',
      placeholder: 'Proyectos',
      input: true,
      okText: 'Crear'
    }).then(function (name) {
      if (!name) return;
      return Drive.createFolder(name, folderId).then(function () {
        toast('Carpeta creada');
        return reload();
      });
    }).catch(function (err) { toast(driveMessage(err)); });
  }

  /* ------------------------------------------------------------- arranque */

  function startOwn() {
    show(signinBox, false);
    show(folderBox, true);

    Drive.ensureFolder().then(function (id) {
      rootId = id;
      var wanted = queryParams().id;
      return openFolder(Drive.isFileId(wanted) ? wanted : id);
    }).catch(function (err) {
      show(folderBox, false);
      startSignin(driveMessage(err));
    });
  }

  // El botón es también la salida de cualquier tropiezo con la sesión, así que
  // se enseña con el motivo cuando lo hay.
  function startSignin(message) {
    show(signinBox, true);
    var error = document.getElementById('signinError');
    error.textContent = message || '';
    error.hidden = !message;
  }

  // Carpeta ajena: sin sesión, solo lectura, con API key.
  function startShared(id) {
    readPublic = true;
    document.title = 'Carpeta compartida · StaticPage';
    document.getElementById('folderTitle').textContent = 'Carpeta compartida';
    document.getElementById('folderSub').textContent = 'Una selección de páginas compartida con un enlace.';
    document.getElementById('uploadCard').hidden = true;
    document.getElementById('dangerZone').hidden = true;
    addZone.hidden = true;
    show(folderBox, true);

    Drive.listPublic(id).then(function (files) {
      items = files;
      render();
    }).catch(function (err) {
      emptyNote.textContent = err && err.message === 'not-configured'
        ? 'Este StaticPage no tiene configurada la lectura de Google Drive.'
        : 'No se pudo abrir la carpeta. Puede que ya no exista o que haya dejado de ser pública.';
      show(emptyNote, true);
    });
  }

  /* ------------------------------------------------------------- conexiones */

  document.getElementById('file').addEventListener('change', function (event) {
    uploadFiles(event.target.files);
    event.target.value = '';
  });

  document.getElementById('replaceFile').addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    replaceCurrent(file);
  });

  var dropZone = document.getElementById('folderContent');

  // Arrastrar sobre la vista previa no cuenta: ahí se suelta en la página.
  function canDrop() { return Boolean(folderId) && !readPublic && !previewDialog.open; }

  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      event.preventDefault();
      if (canDrop()) dropZone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      event.preventDefault();
      if (type === 'drop' || event.target === document.documentElement || !event.relatedTarget) {
        dropZone.classList.remove('is-over');
      }
    });
  });
  window.addEventListener('drop', function (event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length && canDrop()) uploadFiles(files);
  });

  // Atado siempre, no solo al arrancar sin sesión: el botón es lo que queda
  // cuando la carpeta no se puede abrir, y ahí también tiene que responder.
  document.getElementById('btnSignin').addEventListener('click', function () {
    var btn = document.getElementById('btnSignin');
    btn.disabled = true;
    Drive.getToken(true).then(function () {
      startOwn();
    }).catch(function (err) {
      startSignin(driveMessage(err));
    }).finally(function () { btn.disabled = false; });
  });

  document.getElementById('btnPaste').addEventListener('click', openPaste);
  document.getElementById('btnNewFolder').addEventListener('click', newFolder);

  document.getElementById('btnRefresh').addEventListener('click', function () {
    if (folderId) reload().catch(function (err) { toast(driveMessage(err)); });
  });

  // Desde la vista previa: se cierra antes de abrir otra modal, que dos telones
  // apilados no dejan ver ni el aviso del toast.
  document.getElementById('btnPreviewShare').addEventListener('click', function () {
    if (!previewing) return;
    var item = previewing;
    previewDialog.close();
    openShare(item, 'file');
  });

  document.getElementById('btnPreviewDelete').addEventListener('click', function () {
    if (!previewing) return;
    var item = previewing;
    previewDialog.close();
    removeItem(item);
  });

  document.getElementById('btnPreviewReplace').addEventListener('click', function () {
    if (previewing) document.getElementById('replaceFile').click();
  });

  var dangerToggle = document.getElementById('btnDangerToggle');
  dangerToggle.addEventListener('click', function () {
    var body = document.getElementById('dangerBody');
    var open = body.hidden;
    body.hidden = !open;
    dangerToggle.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('btnDeleteFolder').addEventListener('click', deleteCurrentFolder);

  document.getElementById('btnShareFolder').addEventListener('click', function () {
    if (!folderId) return;
    openShare({ id: folderId, name: currentName() }, 'folder');
  });

  document.getElementById('btnCopyShare').addEventListener('click', async function () {
    var value = document.getElementById('shareLink').value;
    toast(await copyText(value) ? '¡Enlace copiado!' : 'No se pudo copiar');
  });

  document.getElementById('shareLink').addEventListener('focus', function (event) {
    event.target.select();
  });

  document.getElementById('btnUnshare').addEventListener('click', function () {
    if (!sharing) return;
    var id = sharing.id;
    Drive.unpublish(id).then(function () {
      var item = items.filter(function (x) { return x.id === id; })[0];
      if (item) { item.shared = false; refreshRow(item); }
      shareDialog.close();
      toast('Ya no se comparte');
    }).catch(function (err) { toast(driveMessage(err)); });
  });

  /* ------------------------------------------------------------- bootstrap */

  var params = queryParams();

  // Un id malformado lo rechaza el propio listado, con el mismo aviso que una
  // carpeta que ya no existe.
  if (params.f !== undefined) {
    startShared(params.f);
  } else if (!Drive.canPublish()) {
    show(document.getElementById('offBox'), true);
  } else {
    // Recargar no debería obligar a pulsar el botón otra vez: el token sigue
    // vivo en la pestaña, así que la sesión aguanta la recarga sin volver a
    // hablar con Google.
    if (Drive.hasSession()) startOwn();
    else startSignin();
  }
})();
