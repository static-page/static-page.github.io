# StaticPage

Web mobile-first para **publicar páginas HTML desde tu propio Google Drive**:
subes un `.html` —o pegas el código— a una carpeta de tu Drive, lo compartes y
obtienes un enlace corto que lo muestra como una página web. No hay servidor, ni
base de datos, ni hosting: la página vive en la cuenta de quien la publica, que
pone la cuota. StaticPage solo la trae y la enseña.

👉 https://static-page.github.io/

Hermano de [SVGshare](https://github.com/svgshare/svgshare.github.io), del que
hereda la arquitectura y el carril de Drive. Aquí no hay carril autocontenido
(la página dentro de la URL): **todo vive en Google Drive**.

## Cómo funciona

```
portada         https://static-page.github.io/
página          https://static-page.github.io/?p=<fileId>        ~70 caracteres
mi carpeta      https://static-page.github.io/account/
carpeta         https://static-page.github.io/account/?f=<folderId>   solo lectura
```

1. En `/account/` entras con Google. StaticPage crea en tu Drive una carpeta
   **StaticPage**, y ahí subes tus páginas.
2. **Compartir** una página le da el permiso «cualquiera con el enlace puede
   leer» y devuelve `…/?p=<fileId>`.
3. Quien abre el enlace recibe la portada de este sitio, que actúa de **web de
   carga**: lee el archivo de Drive sin sesión, con la API key, y **sustituye
   el documento entero por la página** (`document.open()` / `write()` /
   `close()`). No hay `<iframe>`: la página pasa a ser *el* documento, con su
   `<title>`, su `<html lang>`, sus scripts, sus anclas y la URL del enlace.

Al escribirla, el navegador la analiza como si llegara de la red: los scripts se
ejecutan en orden, el doctype decide el modo estándar o quirks, y
`DOMContentLoaded` y `load` se disparan para la página nueva. Nada de StaticPage
sobrevive: ni su hoja de estilos ni su tema ni sus globales.

La codificación es la del archivo, que se guarda tal cual: BOM, si no UTF-8 si
los bytes lo son de verdad, si no lo que diga su `<meta charset>`, y
windows-1252 como último recurso.

El enlace mide lo mismo pese lo que pese la página, y **no cambia al
reemplazarla**: subir una versión nueva sobre la misma página conserva el
archivo, su id y sus permisos.

## Mi carpeta (`/account/`)

- Entrar con Google (botón; nunca en silencio al cargar, ver más abajo).
- Subir páginas por selector o arrastrándolas, varias a la vez. Si ya hay una
  con el mismo nombre se ofrece **reemplazarla**, que conserva el enlace.
- **Pegar código** para crear una página sin archivo. Sin nombre, toma el de su
  `<title>`.
- **Vista previa** en una modal, para ver la página sin salir de la carpeta.
  Desde ahí se reemplaza, se borra, se comparte o se abre la versión publicada.
- Compartir y dejar de compartir una página, o una carpeta entera.
- Subcarpetas, con migas y la carpeta actual en la URL (`?id=`): recargar y
  «atrás» funcionan.
- Borrar la carpeta en la que estás, en una zona de riesgo plegada.
- Barra de cuota del Drive.

Todo lo que pregunta usa un `<dialog>` de la página, no `confirm()` ni
`prompt()`.

Una carpeta compartida (`/account/?f=…`) se abre sin cuenta: lista sus páginas y
cada una lleva al visor.

## Seguridad

### Lo que implica sustituir el documento

El visor no aísla la página en un `<iframe>`: la escribe en su propio documento,
así que **la página se ejecuta en el origen de StaticPage**. Eso es lo que hace
que se comporte como una web de verdad (título, anclas, `localStorage`, URL),
y también lo que obliga a tomar precauciones, porque la carpeta, con la sesión
de Drive, vive en ese mismo origen.

Lo que se hace antes de escribir la página:

- **El token de Drive sale de la pestaña.** Si la pestaña venía de la carpeta,
  el token está en su `sessionStorage`; el visor lo borra antes de escribir.
- **El visor nunca carga la biblioteca de Google** (Google Identity Services).
- **Los globales de StaticPage desaparecen**, incluida la configuración.
- **Desde la carpeta, el visor se abre siempre con `rel="noopener"`**: la
  página no recibe `window.opener` y no puede tocar la pestaña de la carpeta.
- **La vista previa de la carpeta sí va aislada**: un `<iframe>` con `sandbox`
  sin `allow-same-origin`, en un origen opaco. Al lado está el token.

Lo que **no** se puede evitar mientras página y carpeta compartan origen:

- **Una página puede pedir un token a Google con el client id de este sitio.**
  El origen está autorizado en el cliente OAuth, así que una página maliciosa
  puede abrir el flujo de Google Identity Services por su cuenta; a quien ya
  dio su consentimiento a StaticPage le basta un clic para que la página reciba
  un token `drive.file`, con el que leer, reemplazar o borrar **sus** páginas
  de StaticPage. Es el escenario de un gusano: una página que, al visitarla,
  se copia en las páginas del visitante.
- **Todas las páginas comparten origen** entre sí y con StaticPage: lo que una
  guarde en `localStorage`, `IndexedDB` o cookies lo pueden leer las demás.
- Una página puede abrir `/account/` en una ventana suya y manejarla.

### La solución: el visor en otro origen

Es lo que hace Google con `googleusercontent.com`. Se despliega este mismo
repositorio en un **segundo origen** (otra cuenta u organización de GitHub
Pages, o un dominio propio) **solo con la API key**, y en el despliegue
principal se indica con `VIEWER_URL`:

```
static-page.github.io        la carpeta     GOOGLE_CLIENT_ID + GOOGLE_API_KEY + VIEWER_URL
paginas.example.com          el visor       GOOGLE_API_KEY (sin client id)
```

Los enlaces que reparte la carpeta pasan a apuntar a `VIEWER_URL`. Allí las
páginas se ejecutan en un origen **sin token y que no figura en el cliente
OAuth**, así que no pueden pedir uno; la API key debe admitir los dos orígenes
como referrer. Sin `VIEWER_URL`, el despliegue avisa en el resumen de GitHub
Actions.

### Lo demás

- El token de acceso vive en memoria y en el `sessionStorage` de la pestaña,
  nunca en `localStorage` ni en cookies, y se tira en cuanto caduca o Drive
  contesta 401. Sin `sessionStorage`, recargar vuelve a pedir el botón.
- Pedir el token «en silencio» al cargar (`prompt: 'none'`) no es opción: el
  token client de Google abre una ventana emergente, y sin un clic detrás el
  navegador la bloquea y avisa.
- El id de archivo de la URL se valida contra `/^[A-Za-z0-9_-]{10,200}$/` antes
  de construir ninguna petición.
- El visor no descarga más de 10 MB, y rechaza binarios (un PDF enlazado como
  si fuera una página) y archivos vacíos.
- La página **no se sanea**: es de quien la publica, con sus scripts. Lo que la
  separa de la sesión no es limpiarla, sino dónde se ejecuta.
- Cualquiera puede publicar, y las páginas se ven bajo el dominio de este
  sitio. Si una página no carga, el visor ofrece abrirla en Google Drive, que es
  donde se denuncian los abusos.

## Configuración

1. **Client ID** — Cloud console › Clients › OAuth 2.0, tipo *Web application*.
   Añade el origen autorizado de JavaScript (`https://static-page.github.io` y
   `http://localhost:8080` para desarrollo). **No** añadas el origen del visor si
   lo separas. No hace falta redirect URI. Habilita **publicar**.
2. **API key** — Credentials › API key, restringida por referrer HTTP a los
   orígenes del sitio (y del visor, si va aparte) y limitada a la Drive API.
   Habilita **leer** las páginas públicas sin sesión.
3. Habilita la **Google Drive API** en el proyecto.
4. Publica la pantalla de consentimiento en *In production*.

Con solo una de las dos credenciales la carpeta **no aparece**, a propósito:
publicar enlaces que este mismo despliegue no sabe abrir es peor que no
ofrecerlo.

En el despliegue los valores salen de las variables del repositorio
`GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` (valen variables o secretos) y
`VIEWER_URL` (opcional), y `tools/write-config.js` escribe `assets/config.js`
antes de publicar. Las credenciales son públicas por diseño —viajan en el
navegador— y su seguridad viene de estar restringidas por origen. Para
desarrollo local:

```bash
GOOGLE_CLIENT_ID=… GOOGLE_API_KEY=… node tools/write-config.js
```

El único scope es `drive.file`: acceso solo a los archivos que la propia app
crea. Es **no sensible**: sin verificación de Google, sin aviso de «app no
verificada» y sin tope de 100 usuarios. No se piden `email` ni `profile` para no
salir de esa categoría. A cambio, StaticPage no ve lo que el usuario meta en la
carpeta desde la web de Drive: solo lo que suba desde aquí.

**Cuentas de Google Workspace**: muchas organizaciones prohíben compartir fuera
del dominio. Ahí compartir falla, y la carpeta lo dice. Con una cuenta personal
de Google funciona.

## Límites

- **Una página, un archivo.** CSS, JS e imágenes dentro del HTML (o desde URLs
  absolutas, un CDN por ejemplo). Las rutas relativas (`foto.jpg`,
  `estilos.css`) se resuelven contra este sitio y no cargan.
- Hasta **10 MB** por página.
- La vista previa de la carpeta va aislada en un origen opaco: una página que
  dependa de `localStorage` o de cookies puede fallar ahí, pero no en el visor.
- Las tarjetas de Telegram, WhatsApp o Slack son **fijas** (`og.jpg`): el
  rastreador recibe la portada, no la página, que solo existe después de
  ejecutar JavaScript. Una tarjeta por página exigiría un host dinámico (una
  función edge que lea `?p=` y pida los metadatos a Drive). Por eso el id va en
  la query string y no en el fragmento: deja esa puerta abierta.

## Tema

Claro y oscuro, con un selector en el pie: **automático** (sigue al sistema),
claro u oscuro. Se aplica antes del primer pintado y, sin `localStorage`, cae en
automático. El tema es de StaticPage: la página publicada no lo hereda, y el
lienzo de la vista previa es siempre blanco.

## Estructura

```
index.html            portada + visor (?p=<id>)
account/index.html    la carpeta en Google Drive
assets/style.css      estilos mobile-first, claro y oscuro
assets/theme.js       selector de tema, aplicado antes del primer pintado
assets/page.js        lo compartido sobre páginas: decodificar, nombre, título,
                      sustituir el documento y el marco aislado de la vista previa
assets/drive.js       Google Drive: OAuth, carpeta, subir, reemplazar, permisos, cuota
assets/app.js         portada y visor
assets/account.js     la carpeta
assets/config.js      credenciales; vacío en el repo, se genera al desplegar
og.jpg                imagen de la tarjeta de previsualización
test/                 suites de Playwright (Drive simulado + specs)
tools/write-config.js genera assets/config.js desde el entorno del despliegue
playwright.config.js  Chromium a 390 px, servidor estático incluido
package.json          solo para los tests; la web no tiene build
.github/workflows/    deploy.yml (Pages) y test.yml (tests)
```

## Desarrollo

La web no tiene build ni dependencias; es HTML, CSS y JS estáticos:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Tests

95 comprobaciones con Playwright sobre Chromium a 390 px:

```bash
npm install
npx playwright install chromium
npm test
```

| Suite | Nº | Qué cubre |
| --- | --- | --- |
| `test/viewer.spec.js` | 17 | sustitución del documento, scripts y eventos, global limpio, token fuera, anclas, codificaciones, errores |
| `test/account.spec.js` | 48 | la carpeta entera: entrar, subir, reemplazar, pegar, vista previa aislada, compartir, carpetas |
| `test/landing.spec.js` | 6 | la portada con y sin credenciales |
| `test/theme.spec.js` | 7 | selector de tema y persistencia |
| `test/page.spec.js` | 7 | `assets/page.js`: tipos, nombres, codificaciones, título, sandbox |
| `test/config.spec.js` | 10 | `tools/write-config.js`: escapado, `VIEWER_URL`, avisos |

Las pruebas simulan Google entero —incluido `assets/config.js`— con un Drive de
mentira con estado (`test/google-mock.js`), así que no hacen falta credenciales;
a cambio, no demuestran que Google responda como se supone.

## Despliegue

GitHub Actions publica la web en GitHub Pages con cada push a `main`
(`.github/workflows/deploy.yml`). Requiere activar **Settings → Pages → Build and
deployment → Source: GitHub Actions** una sola vez en el repositorio.

## Pendiente

1. **Comprobar contra Google.** SVGshare confirmó que `files.get?alt=media` con
   API key devuelve CORS desde otro origen para un SVG público. Falta verlo con
   un archivo `text/html` y, como en SVGshare, el listado anónimo de una carpeta
   pública (`/account/?f=`).
2. **El visor en un origen aparte** (`VIEWER_URL`), ver «Seguridad». El código
   lo admite; falta el segundo despliegue.
3. **Sitios de varios archivos**: resolver rutas relativas contra otros archivos
   de la misma carpeta de Drive.
4. **Tarjeta por página** con una función edge que lea `?p=`.
