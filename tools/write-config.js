#!/usr/bin/env node
/*
 * Escribe assets/config.js en el despliegue, a partir del entorno.
 *
 * Las credenciales son públicas por diseño —viajan en el navegador— así que no
 * son secretos que proteger, sino valores que no queremos fijar en el
 * repositorio: cada despliegue (o cada fork) usa los suyos. Su seguridad viene
 * de estar restringidas por origen en la consola de Google.
 *
 * Los valores se serializan con JSON.stringify, de modo que un valor con
 * comillas o saltos de línea no puede escaparse del literal ni inyectar código.
 *
 *   GOOGLE_CLIENT_ID   habilita publicar (la carpeta)
 *   GOOGLE_API_KEY     habilita leer páginas públicas sin sesión (el visor)
 *   VIEWER_URL         opcional: otro origen donde se abren las páginas
 *
 * Sin ninguna, el fichero queda vacío y no se puede publicar ni ver nada.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2] || path.join(__dirname, '..', 'assets', 'config.js');

const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const apiKey = (process.env.GOOGLE_API_KEY || '').trim();
const rawViewer = (process.env.VIEWER_URL || '').trim();

// Solo una URL http(s) absoluta: el valor acaba en los enlaces que se reparten.
let viewerUrl = '';
let viewerRejected = false;
if (rawViewer) {
  try {
    const url = new URL(rawViewer);
    if (url.protocol === 'https:' || url.protocol === 'http:') viewerUrl = url.href;
    else viewerRejected = true;
  } catch (err) {
    viewerRejected = true;
  }
}

const body = `/*
 * Generado en el despliegue por tools/write-config.js. No editar a mano:
 * los valores salen de GOOGLE_CLIENT_ID, GOOGLE_API_KEY y VIEWER_URL.
 */
window.STATICPAGE_CONFIG = {
  googleClientId: ${JSON.stringify(clientId)},
  googleApiKey: ${JSON.stringify(apiKey)},
  viewerUrl: ${JSON.stringify(viewerUrl)}
};
`;

fs.writeFileSync(target, body, 'utf8');

/* ------------------------------------------------------- lo que queda activo */

const notes = [];
notes.push(`Publicar (carpeta): ${clientId ? 'activado' : 'desactivado'}`);
notes.push(`Leer páginas públicas (visor): ${apiKey ? 'activado' : 'desactivado'}`);
notes.push(`Visor: ${viewerUrl || 'este mismo sitio'}`);

// Media configuración es peor que ninguna: la carpeta repartiría enlaces que
// este mismo despliegue no sabe abrir.
if (Boolean(clientId) !== Boolean(apiKey)) {
  notes.push(clientId
    ? '**Aviso**: hay client id pero no API key. Se podría guardar en Drive, pero el ' +
      'visor no sabría leer esas páginas. La carpeta se queda oculta hasta que exista ' +
      'GOOGLE_API_KEY.'
    : '**Aviso**: hay API key pero no client id. El visor puede abrir páginas publicadas ' +
      'desde otro despliegue, pero aquí no se puede publicar nada.');
}

if (viewerRejected) {
  notes.push('**Aviso**: VIEWER_URL no es una URL http(s) absoluta y se ha ignorado: ' +
    'las páginas se abren en este mismo sitio.');
}

if (clientId && !viewerUrl) {
  notes.push('**Aviso**: las páginas se abren en el mismo origen que la carpeta. ' +
    'Ver «Seguridad» en el README para servirlas desde un origen aparte (VIEWER_URL).');
}

for (const note of notes) console.log(note.replace(/\*\*/g, ''));

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    ['### Credenciales de Google', '', ...notes.map((n) => `- ${n}`), ''].join('\n')
  );
}
