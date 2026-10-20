/*
 * Credenciales de Google Drive. Las dos son públicas por diseño (viajan en el
 * navegador); su seguridad viene de restringirlas por origen:
 *
 *   googleClientId — Cloud console › Clients › OAuth 2.0, tipo "Web application".
 *                    Añade el origen autorizado de JavaScript, p. ej.
 *                    https://static-page.github.io y http://localhost:8080 para
 *                    desarrollo. No hace falta redirect URI: el token client de
 *                    Google Identity Services usa una ventana emergente.
 *
 *   googleApiKey   — Cloud console › Credentials › API key, restringida por
 *                    referrer HTTP al mismo origen y limitada a la Drive API.
 *                    La usa el visor para leer páginas ya públicas sin sesión.
 *
 *   viewerUrl      — Opcional. Dónde se abren las páginas publicadas, si no es
 *                    este mismo sitio (p. ej. https://paginas.example.com/).
 *                    Ver «Seguridad» en el README: servirlas desde un origen
 *                    sin client id aísla la carpeta de lo que hagan las páginas.
 *
 * Con las credenciales vacías el sitio no puede publicar ni mostrar nada: todo
 * vive en el Drive de quien publica.
 */
window.STATICPAGE_CONFIG = {
  googleClientId: '',
  googleApiKey: '',
  viewerUrl: ''
};
