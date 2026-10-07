/**
 * Prueba en navegador de la pantalla de Novedades.
 *
 * Nació con una ventana fija de 60 días, igual que Viajes con 14: es otra
 * pantalla donde se revisa, y con una ventana fija había que creerle en vez
 * de poder auditarla. Se comprueba que el período sea libre y recordado, que
 * «toda la operación» arranque en la primera novedad de verdad y que los
 * filtros acoten lo ya descargado.
 *
 *   node worker/pruebas/prueba_novedades.mjs
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(AQUI, '../..');
const PUERTO = Number(process.env.PUERTO) || 8796;
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
  console.log('(sin Playwright: se salta la prueba de la pantalla de Novedades)');
  process.exit(0);
}

const servidor = spawn(process.execPath, [path.join(AQUI, 'servidor_local.mjs')],
  { cwd: APP, env: { ...process.env, PUERTO: String(PUERTO) }, stdio: 'ignore' });
const esperar = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try { await fetch(`${BASE}/api/salud`); break; } catch { await esperar(250); }
}

const nav = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await nav.newContext({
  locale: 'es-CO', timezoneId: 'America/Bogota', viewport: { width: 1400, height: 950 },
});
const pag = await ctx.newPage();
const errores = [];
pag.on('pageerror', e => errores.push(e.message));

const tarjetas = () => pag.locator('#ev-lista .card').count();

try {
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await pag.fill('#in-usuario', 'coordina');
  await pag.fill('#in-clave', 'Coordina2026');
  await pag.click('#in-btn');
  await pag.waitForSelector('#app:not([hidden])');

  // Novedades repartidas en el tiempo, para que el período signifique algo.
  await pag.evaluate(async () => {
    const veh = vehiculos[0].id;
    for (const d of [-120, -75, -40, -3]) {
      await api('/api/eventos', { metodo: 'POST', cuerpo: {
        tipo: d === -3 ? 'reten' : 'derrumbe', gravedad: 'media', vehiculo_id: veh,
        descripcion: `Novedad sembrada a ${d} días`,
        ts_evento: nDias(hoy(), d) + 'T12:00:00Z',
      } });
    }
  });

  await pag.click('.nav button:has-text("Novedades")');
  await pag.waitForSelector('#ev-lista');
  await pag.waitForTimeout(800);

  // ── El período ───────────────────────────────────────────────────────────
  console.log('\n══ El período ya no son 60 días fijos ══');

  verificar('se puede escoger el período',
    await pag.locator('#ev-desde').count() === 1 && await pag.locator('#ev-hasta').count() === 1);
  verificar('la cabecera dice qué período se está viendo',
    /Del \d{4}-\d{2}-\d{2} al \d{4}-\d{2}-\d{2}/.test(
      await pag.locator('#ev-cuenta').innerText()));

  const de60 = await tarjetas();
  verificar('arranca en los últimos 60 días, como antes', de60 > 0, `${de60}`);

  await pag.click('.chip:has-text("Toda la operación")');
  await pag.waitForTimeout(1200);
  const total = await tarjetas();
  verificar('«Toda la operación» alcanza las de hace más de 60 días',
    total > de60, `${total} contra ${de60}`);

  const rango = await pag.evaluate(() => api('/api/eventos/rango'));
  verificar('y arranca en la primera novedad de verdad',
    await pag.inputValue('#ev-desde') === rango.primera,
    `${await pag.inputValue('#ev-desde')} contra ${rango.primera}`);
  verificar('se ve la novedad de hace cuatro meses',
    /120 días/.test(await pag.locator('#ev-lista').innerText()));

  await pag.fill('#ev-desde', '2020-01-01');
  await pag.fill('#ev-hasta', '2020-12-31');
  await pag.click('button:has-text("Aplicar")');
  await pag.waitForTimeout(900);
  verificar('un período sin novedades sale vacío, no lleno',
    await tarjetas() === 1 && /Sin novedades/.test(await pag.locator('#ev-lista').innerText()),
    `${await tarjetas()}`);

  await pag.click('.chip:has-text("Toda la operación")');
  await pag.waitForTimeout(1200);

  // ── Se recuerda ──────────────────────────────────────────────────────────
  console.log('\n══ El período se recuerda ══');
  await pag.reload({ waitUntil: 'networkidle' });
  await pag.waitForSelector('#app:not([hidden])');
  await pag.click('.nav button:has-text("Novedades")');
  await pag.waitForSelector('#ev-lista');
  await pag.waitForTimeout(900);
  verificar('sobrevive a recargar la página',
    await pag.inputValue('#ev-desde') === rango.primera,
    await pag.inputValue('#ev-desde'));

  // ── Los filtros ──────────────────────────────────────────────────────────
  console.log('\n══ Filtrar lo descargado ══');

  const derrumbes = await pag.evaluate(() =>
    eventosCargados.filter(e => e.tipo === 'derrumbe').length);
  await pag.selectOption('.filtros-tray select', 'derrumbe');
  await pag.waitForTimeout(400);
  verificar('el filtro de tipo acota la lista',
    await tarjetas() === derrumbes, `${await tarjetas()} contra ${derrumbes}`);
  verificar('y la cabecera dice cuántas quedan',
    /tras los filtros/.test(await pag.locator('#ev-cuenta').innerText()));

  await pag.selectOption('.filtros-tray select', '');
  await pag.waitForTimeout(400);
  const abiertas = await pag.evaluate(() =>
    eventosCargados.filter(e => e.estado !== 'cerrado').length);
  await pag.check('.marca-check input');
  await pag.waitForTimeout(400);
  verificar('se pueden aislar las que siguen abiertas',
    await tarjetas() === abiertas, `${await tarjetas()} contra ${abiertas}`);

  verificar('ninguna excepción en la consola', errores.length === 0, errores[0]);
} finally {
  await ctx.close();
  await nav.close();
  servidor.kill();
}

console.log(`\n${pruebas - fallos}/${pruebas} comprobaciones correctas`);
if (fallos) { console.log(`${fallos} FALLO(S)`); process.exit(1); }
