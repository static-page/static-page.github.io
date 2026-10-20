/*
 * Lo que hay que saber de una página HTML, compartido por el visor y la vista
 * de carpeta: qué archivo cuenta como página, cómo convertir sus bytes en
 * texto, cómo se llama, y las dos formas de pintarla.
 *
 *   replaceDocument()  el visor: la página sustituye por completo al documento
 *                      que la ha traído, con la URL de este sitio.
 *   previewFrame()     la vista de carpeta: un <iframe> con sandbox y sin
 *                      allow-same-origin, porque al lado vive la sesión de Drive.
 *
 * No hay saneado: la página es de quien la publica, con sus scripts. Lo que la
 * separa de la sesión no es limpiarla, sino dónde se ejecuta (ver README,
 * «Seguridad»).
 */
(function (global) {
  'use strict';

  var MAX_BYTES = 10 * 1024 * 1024;
  var MIME = 'text/html';
  var NAME_MAX = 120;

  // Scripts, formularios, alert() y ventanas nuevas, pero nunca el mismo
  // origen: con allow-same-origin y allow-scripts juntos, el marco podría
  // quitarse el sandbox y leer la sesión de la página que lo contiene.
  var SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups ' +
    'allow-popups-to-escape-sandbox allow-downloads';

  function isHtmlFile(file) {
    return Boolean(file) && (/^text\/html\b/i.test(file.type || '') || /\.html?$/i.test(file.name || ''));
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',') + ' GB';
  }

  // El nombre llega de un archivo o de lo que se teclee: un único segmento de
  // ruta, sin caracteres de control y con un tope razonable.
  function cleanName(raw) {
    var name = String(raw || '').split(/[\\/]/).pop()
      .replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return name.slice(0, NAME_MAX);
  }

  function htmlName(raw) {
    var name = cleanName(raw) || 'pagina';
    return /\.html?$/i.test(name) ? name : name + '.html';
  }

  /* ---------------------------------------------------------- bytes → texto */

  // Se guarda el archivo tal cual, así que la codificación es la suya. El orden
  // es el de un navegador sensato: BOM, luego UTF-8 si los bytes lo son de
  // verdad, luego lo que diga su <meta charset>, y windows-1252 como último
  // recurso, que es lo que asumiría un navegador sin más pistas.
  function sniff(bytes) {
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return 'utf-8';
    } catch (err) { /* no es UTF-8: se busca la declaración */ }

    var head = '';
    var end = Math.min(bytes.length, 1024);
    for (var i = 0; i < end; i++) head += String.fromCharCode(bytes[i]);
    var match = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i);
    // Un <meta> que dice UTF-16 en un archivo sin BOM no puede ser cierto: lo
    // habría leído como ASCII. Los navegadores lo tratan como UTF-8.
    if (match && !/^utf-?16/i.test(match[1])) return match[1];
    return 'windows-1252';
  }

  function decode(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var label = sniff(bytes);
    try {
      return new TextDecoder(label).decode(bytes);
    } catch (err) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  // Un NUL en el primer KB es un binario (un PDF, una imagen…), no una página.
  // UTF-16 lleva ceros por todas partes, pero ese ya se ha reconocido por el BOM.
  function looksBinary(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var label = sniff(bytes);
    if (/^utf-16/.test(label)) return false;
    var end = Math.min(bytes.length, 1024);
    for (var i = 0; i < end; i++) if (bytes[i] === 0) return true;
    return false;
  }

  // DOMParser no ejecuta scripts ni pide recursos: sirve para leer el <title>
  // de una página ajena sin que haga nada.
  function titleOf(html) {
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      return (doc.title || '').trim();
    } catch (err) {
      return '';
    }
  }

  /* --------------------------------------------------------------- pintarla */

  // El visor: la página pasa a ser el documento. document.open() vacía este,
  // y lo que se escribe se analiza como si llegara de la red, scripts incluidos;
  // DOMContentLoaded y load se disparan otra vez para la página nueva.
  function replaceDocument(html, doc) {
    var target = doc || global.document;
    target.open();
    target.write(String(html));
    target.close();
  }

  // La vista previa: aislada en un origen opaco. Las páginas que dependan de
  // localStorage o de cookies pueden fallar aquí, pero no en el visor.
  function previewFrame(html, title) {
    var frame = document.createElement('iframe');
    // El sandbox va antes que el contenido: se aplica al navegar, no después.
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'frame';
    frame.title = title || 'Vista previa';
    frame.srcdoc = String(html);
    return frame;
  }

  global.StaticPage = {
    MAX_BYTES: MAX_BYTES,
    MIME: MIME,
    SANDBOX: SANDBOX,
    isHtmlFile: isHtmlFile,
    formatBytes: formatBytes,
    cleanName: cleanName,
    htmlName: htmlName,
    sniff: sniff,
    decode: decode,
    looksBinary: looksBinary,
    titleOf: titleOf,
    replaceDocument: replaceDocument,
    previewFrame: previewFrame
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
