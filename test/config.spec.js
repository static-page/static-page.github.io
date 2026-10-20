/*
 * tools/write-config.js genera assets/config.js en el despliegue. Lo que
 * importa es que un valor hostil no pueda escaparse del literal: la salida es
 * un fichero JS que el navegador ejecuta.
 */
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = path.join(__dirname, '..', 'tools', 'write-config.js');

// Ejecuta el generador y devuelve tanto el texto como el objeto resultante.
function generate(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staticpage-config-'));
  const target = path.join(dir, 'config.js');
  const log = execFileSync(process.execPath, [SCRIPT, target], {
    env: { ...process.env, GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', VIEWER_URL: '', GITHUB_STEP_SUMMARY: '', ...env },
    encoding: 'utf8'
  });

  const text = fs.readFileSync(target, 'utf8');
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(text, sandbox, { filename: 'config.js' });
  fs.rmSync(dir, { recursive: true, force: true });

  return { text, log, config: sandbox.window.STATICPAGE_CONFIG };
}

test('sin variables todo queda desactivado', () => {
  const { config, log } = generate({});
  expect(config).toEqual({ googleClientId: '', googleApiKey: '', viewerUrl: '' });
  expect(log).toContain('Publicar (carpeta): desactivado');
  expect(log).toContain('Leer páginas públicas (visor): desactivado');
});

test('con las dos credenciales queda completo, y avisa del origen compartido', () => {
  const { config, log } = generate({
    GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    GOOGLE_API_KEY: 'AIzaSyTest'
  });
  expect(config).toEqual({
    googleClientId: '123-abc.apps.googleusercontent.com',
    googleApiKey: 'AIzaSyTest',
    viewerUrl: ''
  });
  expect(log).toContain('Publicar (carpeta): activado');
  expect(log).toContain('Visor: este mismo sitio');
  expect(log).toContain('mismo origen que la carpeta');
});

test('VIEWER_URL se normaliza y quita el aviso', () => {
  const { config, log } = generate({
    GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    GOOGLE_API_KEY: 'AIzaSyTest',
    VIEWER_URL: ' https://paginas.example.com '
  });
  expect(config.viewerUrl).toBe('https://paginas.example.com/');
  expect(log).toContain('Visor: https://paginas.example.com/');
  expect(log).not.toContain('mismo origen que la carpeta');
});

test('una VIEWER_URL que no es http(s) se ignora con aviso', () => {
  const { config, log } = generate({ VIEWER_URL: 'javascript:alert(1)' });
  expect(config.viewerUrl).toBe('');
  expect(log).toContain('VIEWER_URL no es una URL http(s) absoluta');
});

test('solo el client id avisa de que falta la API key', () => {
  const { log } = generate({ GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com' });
  expect(log).toContain('Aviso');
  expect(log).toContain('GOOGLE_API_KEY');
});

test('solo la API key también avisa', () => {
  const { log } = generate({ GOOGLE_API_KEY: 'AIzaSyTest' });
  expect(log).toContain('no client id');
});

test('los espacios de los extremos se recortan', () => {
  const { config } = generate({ GOOGLE_CLIENT_ID: '  id  ', GOOGLE_API_KEY: '\nkey\t' });
  expect(config.googleClientId).toBe('id');
  expect(config.googleApiKey).toBe('key');
});

test('un valor hostil no se escapa del literal', () => {
  const hostile = "x'; window.pwned = 1; '\"</script><script>alert(1)</script>";
  const { config, text } = generate({ GOOGLE_CLIENT_ID: hostile, GOOGLE_API_KEY: hostile });
  expect(config.googleClientId).toBe(hostile);
  expect(config.googleApiKey).toBe(hostile);
  expect(text).not.toContain('window.pwned = 1;\n');
});

test('deja un resumen para la ejecución de GitHub Actions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staticpage-summary-'));
  const summary = path.join(dir, 'summary.md');
  generate({ GOOGLE_API_KEY: 'AIzaSyTest', GITHUB_STEP_SUMMARY: summary });
  const text = fs.readFileSync(summary, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  expect(text).toContain('### Credenciales de Google');
  expect(text).toContain('- Leer páginas públicas (visor): activado');
});

test('el config.js del repositorio va vacío', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'assets', 'config.js'), 'utf8');
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(text, sandbox);
  expect(sandbox.window.STATICPAGE_CONFIG).toEqual({ googleClientId: '', googleApiKey: '', viewerUrl: '' });
});
