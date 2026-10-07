/**
 * Prueba en navegador de la pantalla de Viajes.
 *
 * Se reportó que solo dejaba ver los últimos 14 días: no había forma de
 * revisar un mes cerrado ni de contrastar la operación completa, que es para
 * lo que sirve esa pantalla. Lo que se comprueba aquí:
 *
 *   · que el período sea libre, con atajos y recordado entre visitas;
 *   · que «Toda la operación» arranque en el primer viaje de verdad;
 *   · que los filtros de vehículo, conductor y texto acoten lo descargado;
 *   · que cada viaje abra con TODOS sus campos, los dos odómetros y las dos
 *     horas —la del servidor y la del celular— por separado;
 *   · que lo que se está viendo se pueda descargar.
 *
 *   node worker/pruebas/prueba_viajes.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(AQUI, '../..');
const PUERTO = Number(process.env.PUERTO) || 8794;
const BASE = `http://127.0.0.1:${PUERTO}`;

let fallos = 0, pruebas = 0;
function verificar(nombre, condicion, detalle) {
  pruebas++;
  if (condicion) return console.log(`  OK  ${nombre}`);
  fallos++;
  console.log(`  MAL ${nombre}${detalle !== undefined ? ' — ' + detalle : ''}`);
}

let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright')); }
catch {
  console.log('(sin Playwright: se salta la prueba de la pantalla de Viajes)');
  process.exit(0);
}

const servidor = spawn(process.execPath, [path.join(AQUI, 'servidor_local.mjs')],
  { cwd: APP, env: { ...process.env, PUERTO: String(PUERTO) }, stdio: 'ignore' });
const esperar = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try { await fetch(`${BASE}/api/salud`); break; } catch { await esperar(250); }
}

const descargas = fs.mkdtempSync(path.join(os.tmpdir(), 'viajes-'));
const nav = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
// El día operativo lo calcula el Worker en hora de Colombia.
const ctx = await nav.newContext({
  locale: 'es-CO', timezoneId: 'America/Bogota',
  viewport: { width: 1500, height: 950 }, acceptDownloads: true,
});
const pag = await ctx.newPage();
const errores = [];
pag.on('pageerror', e => errores.push(e.message));

const cuenta = () => pag.locator('#tray-tabla tbody tr').count();

try {
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await pag.fill('#in-usuario', 'coordina');
  await pag.fill('#in-clave', 'Coordina2026');
  await pag.click('#in-btn');
  await pag.waitForSelector('#app:not([hidden])');
  await pag.click('.nav button:has-text("Trayectos")');
  await pag.waitForSelector('#tray-tabla');
  await pag.waitForTimeout(600);

  // ── El período deja de ser fijo ──────────────────────────────────────────
  console.log('\n══ El período ya no son 14 días fijos ══');

  verificar('se puede escoger el período', await pag.locator('#tr-desde').count() === 1
    && await pag.locator('#tr-hasta').count() === 1);
  verificar('la cabecera dice qué período se está viendo',
    /Del \d{4}-\d{2}-\d{2} al \d{4}-\d{2}-\d{2}/.test(
      await pag.locator('#tray-cuenta').innerText()));

  const de14 = await cuenta();
  verificar('arranca en los últimos 14 días, como antes', de14 > 0, `${de14}`);

  // Los datos de ejemplo siembran dos meses de historia: toda la operación
  // tiene que traer bastante más que las dos últimas semanas. Sin esa
  // diferencia la prueba pasaría sin probar nada.
  await pag.click('.chip:has-text("Toda la operación")');
  await pag.waitForTimeout(1200);
  const total = await cuenta();
  verificar('«Toda la operación» trae más que los últimos 14 días',
    total > de14, `${total} contra ${de14}`);

  const rango = await pag.evaluate(() => api('/api/trayectos/rango'));
  const desdeEnPantalla = await pag.inputValue('#tr-desde');
  verificar('y arranca en el primer viaje de verdad, no en una fecha inventada',
    desdeEnPantalla === rango.primera, `${desdeEnPantalla} contra ${rango.primera}`);
  verificar('el total de la pantalla cuadra con el del servidor',
    total === rango.total, `${total} contra ${rango.total}`);

  // Un período anterior al primer viaje tiene que salir vacío: si saliera
  // lleno, la pantalla estaría ignorando las fechas.
  await pag.fill('#tr-desde', '2020-01-01');
  await pag.fill('#tr-hasta', '2020-12-31');
  await pag.click('button:has-text("Aplicar")');
  await pag.waitForTimeout(900);
  verificar('un período sin viajes sale vacío, no lleno',
    await cuenta() === 0 && /Sin viajes registrados/.test(
      await pag.locator('#tray-tabla').innerText()), `${await cuenta()}`);

  await pag.click('.chip:has-text("Mes pasado")');
  await pag.waitForTimeout(1000);
  const [d1, h1] = [await pag.inputValue('#tr-desde'), await pag.inputValue('#tr-hasta')];
  verificar('el atajo del mes pasado cae en un mes completo',
    d1.endsWith('-01') && d1.slice(0, 7) === h1.slice(0, 7) && Number(h1.slice(8)) >= 28,
    `${d1} a ${h1}`);

  // Un período escrito a mano
  await pag.fill('#tr-desde', rango.primera);
  await pag.fill('#tr-hasta', rango.ultima);
  await pag.click('button:has-text("Aplicar")');
  await pag.waitForTimeout(1000);
  verificar('un período escrito a mano se aplica', await cuenta() === total, `${await cuenta()}`);

  // ── Se recuerda ──────────────────────────────────────────────────────────
  console.log('\n══ El período se recuerda ══');
  await pag.click('.nav button:has-text("Dashboard")');
  await pag.waitForTimeout(800);
  await pag.click('.nav button:has-text("Trayectos")');
  await pag.waitForSelector('#tray-tabla');
  await pag.waitForTimeout(900);
  verificar('al volver a la pantalla sigue el período escogido',
    await pag.inputValue('#tr-desde') === rango.primera,
    await pag.inputValue('#tr-desde'));

  await pag.reload({ waitUntil: 'networkidle' });
  await pag.waitForSelector('#app:not([hidden])');
  await pag.click('.nav button:has-text("Trayectos")');
  await pag.waitForSelector('#tray-tabla');
  await pag.waitForTimeout(900);
  verificar('y sobrevive a recargar la página',
    await pag.inputValue('#tr-desde') === rango.primera,
    await pag.inputValue('#tr-desde'));

  // ── Los filtros ──────────────────────────────────────────────────────────
  console.log('\n══ Filtrar lo descargado, sin volver a pedirlo ══');

  const placa = await pag.evaluate(() => trayectosCargados[0].placa);
  const delVehiculo = await pag.evaluate(p =>
    trayectosCargados.filter(x => x.placa === p).length, placa);
  await pag.selectOption('.filtros-tray select >> nth=0',
    { label: placa });
  await pag.waitForTimeout(400);
  verificar('el filtro de vehículo acota la tabla',
    await cuenta() === delVehiculo, `${await cuenta()} contra ${delVehiculo}`);
  verificar('y la cabecera dice cuántos quedan tras los filtros',
    /tras los filtros/.test(await pag.locator('#tray-cuenta').innerText()));

  await pag.selectOption('.filtros-tray select >> nth=0', '');
  await pag.waitForTimeout(400);
  verificar('al quitarlo vuelven todos', await cuenta() === total);

  const consec = await pag.evaluate(() => trayectosCargados[0].consecutivo);
  await pag.fill('#tr-buscar', consec);
  await pag.waitForTimeout(400);
  verificar('se puede buscar por el número del viaje', await cuenta() === 1, `${await cuenta()}`);
  verificar('y el cuadro de búsqueda no pierde el foco al escribir',
    await pag.evaluate(() => document.activeElement?.id) === 'tr-buscar');

  await pag.fill('#tr-buscar', '');
  await pag.waitForTimeout(400);
  const sinGps = await pag.evaluate(() =>
    trayectosCargados.filter(x => x.lat_salida == null || x.lat_llegada == null).length);
  await pag.check('.marca-check input');
  await pag.waitForTimeout(400);
  verificar('se pueden aislar los viajes a los que les falta GPS',
    await cuenta() === sinGps, `${await cuenta()} contra ${sinGps}`);
  await pag.uncheck('.marca-check input');
  await pag.waitForTimeout(400);

  // ── La ficha del viaje ───────────────────────────────────────────────────
  console.log('\n══ Todos los datos de un viaje ══');

  const cerrado = await pag.evaluate(() =>
    trayectosCargados.find(x => x.estado === 'cerrado' && x.km_final && x.ts_salida_disp));
  verificar('hay un viaje cerrado con el que contrastar', !!cerrado);
  await pag.evaluate(id => verTrayecto(id), cerrado.id);
  await pag.waitForSelector('.modal-caja');
  await pag.waitForTimeout(400);
  // Las etiquetas salen en mayúsculas por CSS y los números con separador de
  // miles: se compara sin distinguir mayúsculas y con el número ya formateado.
  const ficha = await pag.locator('.modal-caja').innerText();
  const km = n => new Intl.NumberFormat('es-CO').format(n);

  verificar('la ficha muestra los dos odómetros, no solo la resta',
    ficha.includes(km(cerrado.km_inicial)) && ficha.includes(km(cerrado.km_final)),
    `${km(cerrado.km_inicial)} / ${km(cerrado.km_final)}`);
  verificar('separa la hora del servidor de la del celular',
    /hora del servidor/i.test(ficha) && /hora del celular/i.test(ficha));
  verificar('dice quién registró la marca', /registrado por/i.test(ficha));
  verificar('trae la salida y la llegada por separado',
    /\bsalida\b/i.test(ficha) && /\bllegada\b/i.test(ficha));
  verificar('y el tipo de jornada', /tipo de jornada/i.test(ficha));
  verificar('y la precisión del GPS en metros', /±\d+ m/.test(ficha));
  await pag.click('.modal-pie .btn:has-text("Cerrar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });

  // ── La descarga ──────────────────────────────────────────────────────────
  console.log('\n══ Descargar lo que se está viendo ══');

  const [descarga] = await Promise.all([
    pag.waitForEvent('download'),
    pag.click('button:has-text("Descargar")'),
  ]);
  const destino = path.join(descargas, descarga.suggestedFilename());
  await descarga.saveAs(destino);
  const csv = fs.readFileSync(destino, 'utf8');
  const lineas = csv.trim().split('\n');
  verificar('el archivo trae una línea por viaje, más la cabecera',
    lineas.length === total + 1, `${lineas.length - 1} contra ${total}`);
  verificar('y las columnas que la tabla no muestra',
    /Km inicial/.test(lineas[0]) && /Precision salida/.test(lineas[0])
    && /Hora salida \(celular\)/.test(lineas[0]) && /Observaciones/.test(lineas[0]));
  verificar('el nombre del archivo dice el período',
    descarga.suggestedFilename().includes(rango.primera), descarga.suggestedFilename());

  // Con un filtro puesto se descarga lo filtrado, no todo.
  await pag.fill('#tr-buscar', consec);
  await pag.waitForTimeout(400);
  const [descarga2] = await Promise.all([
    pag.waitForEvent('download'),
    pag.click('button:has-text("Descargar")'),
  ]);
  const destino2 = path.join(descargas, 'filtrado.csv');
  await descarga2.saveAs(destino2);
  verificar('con un filtro puesto se descarga lo filtrado',
    fs.readFileSync(destino2, 'utf8').trim().split('\n').length === 2);

  verificar('ninguna excepción en la consola', errores.length === 0, errores[0]);
} finally {
  await ctx.close();
  await nav.close();
  servidor.kill();
  fs.rmSync(descargas, { recursive: true, force: true });
}

console.log(`\n${pruebas - fallos}/${pruebas} comprobaciones correctas`);
if (fallos) { console.log(`${fallos} FALLO(S)`); process.exit(1); }
