/**
 * Prueba en navegador del Dashboard por conductor y por vehículo (D37).
 *
 * El dashboard comparaba vehículos y no decía nada de los conductores, y no
 * había forma de mirar a uno solo. Se comprueba:
 *
 *   · que exista la sección por conductor, con las cuatro cosas que mide;
 *   · que al enfocar a alguien cambie TODO el tablero, no solo una tabla —si
 *     los contadores de arriba siguieran siendo los de la flota, el número
 *     grande mentiría—;
 *   · que la descarga traiga los dos detalles;
 *   · que la paleta de las gráficas sea la validada, no el azul que se leía
 *     como gris.
 *
 *   node worker/pruebas/prueba_dashboard.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(AQUI, '../..');
const PUERTO = Number(process.env.PUERTO) || 8797;
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
  console.log('(sin Playwright: se salta la prueba del Dashboard)');
  process.exit(0);
}

const servidor = spawn(process.execPath, [path.join(AQUI, 'servidor_local.mjs')],
  { cwd: APP, env: { ...process.env, PUERTO: String(PUERTO) }, stdio: 'ignore' });
const esperar = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try { await fetch(`${BASE}/api/salud`); break; } catch { await esperar(250); }
}

const descargas = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
const nav = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await nav.newContext({
  locale: 'es-CO', timezoneId: 'America/Bogota',
  viewport: { width: 1500, height: 1000 }, acceptDownloads: true,
});
const pag = await ctx.newPage();
const errores = [];
pag.on('pageerror', e => errores.push(e.message));

try {
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await pag.fill('#in-usuario', 'coordina');
  await pag.fill('#in-clave', 'Coordina2026');
  await pag.click('#in-btn');
  await pag.waitForSelector('#app:not([hidden])');
  await pag.click('.nav button:has-text("Dashboard")');
  await pag.waitForSelector('#g-ranking');

  // Todo el período sembrado, para que haya con qué comparar.
  await pag.fill('#d-desde', await pag.evaluate(() => nDias(hoy(), -70)));
  await pag.click('button:has-text("Aplicar")');
  await pag.waitForSelector('#g-ranking');
  await pag.waitForTimeout(1200);

  // ── La sección por conductor ─────────────────────────────────────────────
  console.log('\n══ Estadísticas por conductor ══');

  verificar('hay una gráfica de ranking de conductores',
    await pag.locator('#g-conductores').count() === 1);
  verificar('y sigue estando la de vehículos',
    await pag.locator('#g-ranking').count() === 1);
  verificar('hay una tabla de detalle por conductor',
    /Detalle por conductor/.test(await pag.locator('#main').innerText()));

  // Los encabezados salen en mayúsculas por CSS: se compara sin distinguirlas.
  const cab = (await pag.locator('h2:has-text("Detalle por conductor")')
    .locator('xpath=following::table[1]').innerText()).toLowerCase();
  const mide = (col) => cab.includes(col.toLowerCase());
  for (const col of ['Programados', 'Con despl', 'Viajes', 'Horas', 'Km']) {
    verificar(`la tabla mide «${col}»`, mide(col), cab.split('\n')[1]);
  }
  for (const col of ['Sin GPS', 'Sin señal', 'Abiertos']) {
    verificar(`mide la calidad del registro: «${col}»`, mide(col), cab.split('\n')[1]);
  }
  verificar('cuenta las novedades reportadas', mide('Reportadas'));
  verificar('y el checklist', mide('Diligenciados') && mide('Completos'));
  verificar('las columnas van agrupadas por lo que miden',
    await pag.locator('thead tr.grupo').count() >= 1);
  verificar('se advierte cómo leer la calidad del registro y las novedades',
    /no mide al conductor como trabajador/i.test(await pag.locator('#main').innerText()));

  const filasCond = await pag.locator('h2:has-text("Detalle por conductor")')
    .locator('xpath=following::table[1]//tbody/tr').count();
  verificar('la tabla trae conductores', filasCond > 1, `${filasCond}`);

  // Las dos tablas tienen que contar los mismos días: si no, hay dos verdades.
  const suma = await pag.evaluate(async ([d1, d2]) => {
    const d = await api(`/api/dashboard?desde=${d1}&hasta=${d2}`);
    return {
      veh: d.por_vehiculo.reduce((a, v) => a + (v.dias_con_desplazamiento || 0), 0),
      cond: d.por_conductor.reduce((a, c) => a + (c.dias_con_desplazamiento || 0), 0),
    };
  }, [await pag.inputValue('#d-desde'), await pag.inputValue('#d-hasta')]);
  verificar('vehículos y conductores suman los mismos días',
    suma.veh === suma.cond, `${suma.veh} contra ${suma.cond}`);

  // ── Enfocar en un conductor ──────────────────────────────────────────────
  console.log('\n══ Enfocar en un conductor ══');

  const totalFlota = await pag.locator('.kpi').first().innerText();
  const objetivo = await pag.evaluate(() =>
    (window.__d = null, api('/api/dashboard?desde=' + $('#d-desde').value +
      '&hasta=' + $('#d-hasta').value).then(d =>
      d.por_conductor.find(c => c.dias_con_desplazamiento > 0))));
  verificar('hay un conductor con días para enfocar', !!objetivo, objetivo);

  await pag.selectOption('.filtros-tray select >> nth=0', String(objetivo.id));
  await pag.waitForTimeout(1400);

  verificar('se avisa de que todo lo de abajo es solo de esa persona',
    /solo de/i.test(await pag.locator('#main .nota').first().innerText()));
  verificar('aparece el botón de quitar el enfoque',
    await pag.locator('button:has-text("Quitar el enfoque")').count() === 1);
  verificar('la tabla de conductores queda con uno solo',
    await pag.locator('h2:has-text("Detalle por conductor")')
      .locator('xpath=following::table[1]//tbody/tr').count() === 1);

  const kpiEnfocado = await pag.locator('.kpi').first().innerText();
  verificar('los contadores de arriba cambian: no se quedan con los de la flota',
    kpiEnfocado !== totalFlota, `${kpiEnfocado.replace(/\n/g, ' ')} contra ${totalFlota.replace(/\n/g, ' ')}`);
  const ejecutados = await pag.evaluate(() =>
    Number($$('.kpi .val')[1].textContent.replace(/\D/g, '')));
  verificar('y coinciden con los días de esa persona',
    ejecutados === objetivo.dias_con_desplazamiento,
    `${ejecutados} contra ${objetivo.dias_con_desplazamiento}`);
  verificar('los vehículos siguen listados, para ver cuáles condujo',
    await pag.locator('h2:has-text("Detalle por vehículo")')
      .locator('xpath=following::table[1]//tbody/tr').count() > 1);

  // ── Enfocar en un vehículo ───────────────────────────────────────────────
  console.log('\n══ Enfocar en un vehículo ══');

  await pag.click('button:has-text("Quitar el enfoque")');
  await pag.waitForTimeout(1400);
  verificar('al quitarlo vuelven los números de la flota',
    (await pag.locator('.kpi').first().innerText()) === totalFlota);

  const placa = await pag.evaluate(() => api('/api/dashboard?desde=' + $('#d-desde').value +
    '&hasta=' + $('#d-hasta').value).then(d =>
    d.por_vehiculo.find(v => v.dias_con_desplazamiento > 0)));
  await pag.selectOption('.filtros-tray select >> nth=1', String(placa.id));
  await pag.waitForTimeout(1400);
  verificar('la tabla de vehículos queda con uno solo',
    await pag.locator('h2:has-text("Detalle por vehículo")')
      .locator('xpath=following::table[1]//tbody/tr').count() === 1);
  verificar('y los conductores siguen, para ver quién lo condujo',
    await pag.locator('h2:has-text("Detalle por conductor")')
      .locator('xpath=following::table[1]//tbody/tr').count() >= 1);

  // ── La descarga ──────────────────────────────────────────────────────────
  console.log('\n══ La descarga trae los dos detalles ══');

  await pag.click('button:has-text("Quitar el enfoque")');
  await pag.waitForTimeout(1400);
  const [descarga] = await Promise.all([
    pag.waitForEvent('download'),
    pag.click('button:has-text("Descargar")'),
  ]);
  const destino = path.join(descargas, descarga.suggestedFilename());
  await descarga.saveAs(destino);
  const csv = fs.readFileSync(destino, 'utf8');
  verificar('el archivo trae el detalle por vehículo', /DETALLE POR VEHICULO/.test(csv));
  verificar('y el detalle por conductor', /DETALLE POR CONDUCTOR/.test(csv));
  verificar('con las columnas de calidad del registro',
    /Marcas sin GPS/.test(csv) && /Viajes abiertos/.test(csv));

  // ── La paleta ────────────────────────────────────────────────────────────
  console.log('\n══ La paleta de las gráficas ══');

  const colores = await pag.evaluate(() =>
    graficas['g-ranking'].data.datasets.map(x => x.backgroundColor));
  verificar('la gráfica usa la paleta validada',
    JSON.stringify(colores) === JSON.stringify(['#4e96db', '#1e5aa8', '#0a7d57']), colores);
  verificar('ya no se usa el azul que se leía como gris',
    !colores.includes('#c3d2e6'), colores);
  const coloresCond = await pag.evaluate(() =>
    graficas['g-conductores'].data.datasets.map(x => x.backgroundColor));
  verificar('las dos gráficas comparten la codificación de color',
    JSON.stringify(coloresCond) === JSON.stringify(colores), coloresCond);
  verificar('y las dos llevan leyenda: la identidad no depende solo del color',
    await pag.evaluate(() => graficas['g-conductores'].options.plugins.legend.display !== false
      && graficas['g-ranking'].options.plugins.legend.display !== false));

  // Las etiquetas de la gráfica tienen que distinguir personas: cortar por las
  // dos primeras palabras daba «JEISON OMAR» y «JEISON MANDO», que son dos
  // nombres de pila y no identifican a nadie.
  const etiquetas = await pag.evaluate(() => graficas['g-conductores'].data.labels);
  verificar('las etiquetas de la gráfica no se repiten entre conductores',
    new Set(etiquetas).size === etiquetas.length, etiquetas.join(' | '));
  const apellidos = await pag.evaluate(() => api('/api/dashboard?desde=' + $('#d-desde').value +
    '&hasta=' + $('#d-hasta').value).then(d => d.por_conductor.map(c => c.apellidos)));
  verificar('y llevan el apellido, no el segundo nombre',
    etiquetas.every((e, i) => !apellidos[i] || e.endsWith(apellidos[i].trim().split(/\s+/)[0])),
    etiquetas.join(' | '));

  verificar('ninguna excepción en la consola', errores.length === 0, errores[0]);
} finally {
  await ctx.close();
  await nav.close();
  servidor.kill();
  fs.rmSync(descargas, { recursive: true, force: true });
}

console.log(`\n${pruebas - fallos}/${pruebas} comprobaciones correctas`);
if (fallos) { console.log(`${fallos} FALLO(S)`); process.exit(1); }
