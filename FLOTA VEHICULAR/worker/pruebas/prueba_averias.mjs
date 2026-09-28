/**
 * Prueba en navegador de los días fuera de servicio (D33).
 *
 * La API ya se prueba en prueba_api.mjs. Lo que se comprueba aquí es lo que
 * solo se ve en pantalla y es lo que de verdad se usa:
 *
 *   · que Coordinación registre un rango de días desde Vehículos;
 *   · que al hacerlo se le ofrezca qué hacer con lo que ya estaba programado;
 *   · que los días parados se VEAN en la matriz, también en las casillas
 *     vacías, que es donde se adjudicaría un traslado imposible;
 *   · que el conductor pueda declarar su vehículo averiado desde el celular;
 *   · que después de declararlo su propia pantalla se lo diga.
 *
 *   node worker/pruebas/prueba_averias.mjs
 *
 * Playwright no es dependencia de la aplicación: si no está, se salta entera.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(AQUI, '../..');
const PUERTO = Number(process.env.PUERTO) || 8793;
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
  console.log('(sin Playwright: se salta la prueba de días fuera de servicio)');
  process.exit(0);
}

// El día operativo lo calcula el Worker en hora de Colombia. Sin esta zona, de
// noche el navegador pinta el día siguiente y no cuadra con lo sembrado.
const COMUN = { locale: 'es-CO', timezoneId: 'America/Bogota' };
const TEL = {
  ...COMUN, viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/126 Mobile Safari/537.36',
};

const servidor = spawn(process.execPath, [path.join(AQUI, 'servidor_local.mjs')],
  { cwd: APP, env: { ...process.env, PUERTO: String(PUERTO) }, stdio: 'ignore' });
const esperar = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try { await fetch(`${BASE}/api/salud`); break; } catch { await esperar(250); }
}

const nav = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

async function entrar(ctx, usuario, clave) {
  const pag = await ctx.newPage();
  pag.on('pageerror', e => { console.log('  !!! excepción:', e.message); fallos++; });
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await pag.fill('#in-usuario', usuario);
  await pag.fill('#in-clave', clave);
  await pag.click('#in-btn');
  await pag.waitForSelector('#app:not([hidden])');
  return pag;
}

const ctxCoord = await nav.newContext({ ...COMUN, viewport: { width: 1400, height: 950 } });
const coord = await entrar(ctxCoord, 'coordina', 'Coordina2026');
// La pantalla de Vehículos es solo del administrador: se abre en otra sesión.
const ctxAdmin = await nav.newContext({ ...COMUN, viewport: { width: 1400, height: 950 } });
const admin = await entrar(ctxAdmin, 'danilo', 'Demo2026Clave');

try {
  // ── Registrar el período desde Vehículos ─────────────────────────────────
  console.log('\n══ Coordinación registra los días de avería ══');

  await admin.click('.nav button:has-text("Vehículos")');
  await admin.waitForSelector('#main h1:has-text("Vehículos")');
  await admin.waitForTimeout(600);
  verificar('la tabla de vehículos trae la columna de fuera de servicio',
    await admin.locator('thead th:has-text("Fuera de servicio")').count() === 1);
  verificar('cada vehículo tiene su botón de averías',
    await admin.locator('tbody button:has-text("Averías")').count() > 0);

  // Coordinación NO tiene la pantalla de Vehículos, y sí puede registrar días
  // parados: su acceso está en la columna de placas de la propia matriz. Si
  // faltara, quien programa a diario no podría registrar ninguna avería.
  await coord.click('.nav button:has-text("Itinerario")');
  await coord.waitForSelector('#itin-env');
  await coord.waitForTimeout(900);
  verificar('Coordinación no tiene la pantalla de Vehículos',
    await coord.locator('.nav button:has-text("Vehículos")').count() === 0);
  verificar('pero sí llega a las averías desde la matriz',
    await coord.locator('.itin-td-veh .fs-boton').count() > 0);

  const objetivo = await coord.evaluate(() => {
    const v = vehiculos.find(x => x.activo !== 0);
    return { id: v.id, placa: v.placa };
  });

  await coord.click(`.itin-td-veh:has-text("${objetivo.placa}") .fs-boton`);
  await coord.waitForSelector('.modal-caja:has-text("Fuera de servicio")');
  await coord.waitForTimeout(500);
  verificar('el historial arranca vacío',
    /no tiene días fuera de servicio/i.test(await coord.locator('.modal-caja').innerText()));

  await coord.click('.modal-caja button:has-text("Registrar período")');
  await coord.waitForSelector('#fs-desde');

  // El rango se escoge para que caiga sobre días YA PROGRAMADOS y sobre días
  // vacíos a la vez: los primeros ejercitan el ofrecimiento de cancelarlos, y
  // los segundos son donde se adjudicaría un traslado imposible. Empieza hoy
  // porque la matriz arranca en la semana en curso y un día anterior quedaría
  // fuera de la ventana visible.
  const rango = await coord.evaluate(id => {
    const enLaFila = f => document.querySelector(
      `.itin-celda[data-vehiculo-id="${id}"][data-fecha="${f}"]`);
    const dias = Array.from({ length: itinDias }, (_, i) => nDias(itinDesde, i));
    const conAlgo = dias.filter(f => enLaFila(f) && !enLaFila(f).classList.contains('vacia'));
    const vacio = dias.find(f => enLaFila(f)?.classList.contains('vacia'));
    return { desde: conAlgo[0], hasta: vacio, hayLosDos: !!conAlgo.length && !!vacio };
  }, objetivo.id);
  verificar('el rango de prueba cubre días programados y días vacíos',
    rango.hayLosDos && rango.desde < rango.hasta, JSON.stringify(rango));

  await coord.selectOption('#fs-causa', 'averia');
  await coord.fill('#fs-desde', rango.desde);
  await coord.fill('#fs-hasta', rango.hasta);
  await coord.fill('#fs-desc', 'Caja de velocidades');
  await coord.fill('#fs-taller', 'Taller Ocaña');
  await coord.click('#fs-btn');
  await coord.waitForTimeout(1200);

  const textoModal = await coord.locator('.modal-caja').innerText();
  verificar('ofrece qué hacer con los días ya programados',
    /Días ya programados/i.test(textoModal), textoModal.slice(0, 80));
  verificar('y no cancela nada por su cuenta: hay que decidirlo',
    await coord.locator('.modal-caja button:has-text("Dejarlos como están")').count() === 1);

  const paraCancelar = await coord.locator('.modal-caja button:has-text("Cancelar los")').count();
  if (paraCancelar) {
    await coord.click('.modal-caja button:has-text("Cancelar los")');
    await coord.waitForTimeout(1500);
  } else {
    await coord.click('.modal-caja button:has-text("Dejarlos como están")');
    await coord.waitForTimeout(800);
  }

  // ── Se ve en la matriz ───────────────────────────────────────────────────
  console.log('\n══ Los días parados se ven en la matriz ══');

  await coord.click('.nav button:has-text("Itinerario")');
  await coord.waitForSelector('#itin-env');
  await coord.waitForTimeout(900);

  const marcadas = await coord.locator(
    `.itin-celda.fs[data-vehiculo-id="${objetivo.id}"]`).count();
  verificar('los días del rango salen marcados en la matriz', marcadas >= 2, `${marcadas}`);
  verificar('también los que estaban vacíos, que es donde se adjudicaría',
    await coord.locator(`.itin-celda.vacia.fs[data-vehiculo-id="${objetivo.id}"]`).count() > 0);
  verificar('la fila dice cuántos días lleva fuera de servicio',
    /día\(s\) fuera de servicio/.test(
      await coord.locator(`.itin-td-veh:has-text("${objetivo.placa}")`).innerText()));

  // Al programar ese día, la ventana avisa; pero no bloquea.
  const celdaFS = coord.locator(
    `.itin-celda.vacia.fs[data-vehiculo-id="${objetivo.id}"]`).first();
  await celdaFS.click();
  await coord.waitForSelector('.modal-caja');
  const avisoTexto = await coord.locator('.modal-caja').innerText();
  verificar('al programar ese día se avisa que está fuera de servicio',
    /fuera de servicio/i.test(avisoTexto));
  verificar('y dice la causa', /Avería o varada/i.test(avisoTexto));
  verificar('pero deja programar igual: la decisión es del usuario',
    await coord.locator('#it-btn').isEnabled());
  await coord.click('.modal-pie .btn.sec:has-text("Cerrar")');
  await coord.waitForSelector('.modal-caja', { state: 'hidden' });

  // ── El conductor lo declara desde el celular ─────────────────────────────
  console.log('\n══ El conductor declara su vehículo averiado ══');

  const ctxCond = await nav.newContext(TEL);
  const cond = await entrar(ctxCond, 'jnavarro', 'Conductor2026');
  await cond.waitForTimeout(900);

  const suyo = await cond.evaluate(() => diaActual?.vehiculo_id || null);
  verificar('el conductor tiene vehículo asignado hoy', !!suyo, String(suyo));

  const yaParado = await cond.evaluate(() => !!diaActual?.fuera_servicio);
  if (yaParado) {
    // Su propio vehículo es el que Coordinación acaba de parar: se comprueba
    // el aviso y se cierra el período para poder probar el reporte.
    verificar('su pantalla le dice que el vehículo está fuera de servicio',
      /fuera de servicio/i.test(await cond.locator('#main').innerText()));
    verificar('y no le ofrece reportarlo otra vez',
      await cond.locator('button:has-text("El vehículo quedó averiado")').count() === 0);

    await coord.evaluate(async id => {
      const lista = await api('/api/fuera-servicio?vehiculo_id=' + id);
      for (const p of lista) await api('/api/fuera-servicio/' + p.id, { metodo: 'DELETE', cuerpo: {} });
    }, suyo).catch(() => {});
    await cond.reload({ waitUntil: 'networkidle' });
    await cond.waitForSelector('#app:not([hidden])');
    await cond.waitForTimeout(900);
  }

  verificar('con el vehículo bueno, se le ofrece declararlo averiado',
    await cond.locator('button:has-text("El vehículo quedó averiado")').count() === 1);

  await cond.click('button:has-text("El vehículo quedó averiado")');
  await cond.waitForSelector('#av-desc');
  const textoAv = await cond.locator('.modal-caja').innerText();
  verificar('se le dice que queda parado DESDE HOY', /desde hoy/i.test(textoAv));
  verificar('no se le pide fecha de regreso: no la sabe',
    await cond.locator('#av-hasta').count() === 0);

  await cond.selectOption('#av-causa', 'averia');
  await cond.fill('#av-desc', 'Se partió la correa saliendo de Ábrego');
  await cond.fill('#av-km', '184300');
  await cond.click('#av-btn');
  await cond.waitForSelector('.modal-caja', { state: 'hidden' });
  await cond.waitForTimeout(1200);

  verificar('después de reportarlo, su pantalla se lo dice',
    /registrado fuera de servicio/i.test(await cond.locator('#main').innerText()));
  verificar('y ya no le ofrece volver a reportarlo',
    await cond.locator('button:has-text("El vehículo quedó averiado")').count() === 0);

  // ── Coordinación lo ve, y lo cierra ──────────────────────────────────────
  console.log('\n══ Coordinación lo ve y cierra el período ══');

  await admin.click('.nav button:has-text("Vehículos")');
  await admin.waitForSelector('#main h1:has-text("Vehículos")');
  await admin.waitForTimeout(900);
  verificar('la cabecera cuenta los vehículos parados ahora mismo',
    /fuera de servicio ahora/i.test(await admin.locator('#main .cab').innerText()));

  await coord.click('.nav button:has-text("Itinerario")');
  await coord.waitForSelector('#itin-env');
  await coord.waitForTimeout(900);
  const placaSuyo = await coord.evaluate(id => vehiculos.find(v => v.id === id)?.placa, suyo);
  await coord.click(`.itin-td-veh:has-text("${placaSuyo}") .fs-boton`);
  await coord.waitForSelector('.modal-caja:has-text("Fuera de servicio")');
  await coord.waitForTimeout(500);
  const hist = await coord.locator('.modal-caja').innerText();
  verificar('el reporte del conductor aparece en el historial',
    /correa saliendo de Ábrego/i.test(hist), hist.slice(0, 120));
  verificar('y se ve que lo reportó el conductor, no Coordinación',
    /Reportado por el conductor/i.test(hist));
  verificar('se avisa de que sigue parado y cada día deja de ser pagable',
    /Sigue fuera de servicio/i.test(hist));

  await coord.click('.modal-caja tbody button:has-text("Editar")');
  await coord.waitForSelector('#fs-hasta');
  verificar('al editar un período abierto se pide el motivo del cierre',
    await coord.locator('#fs-motivo').count() === 1);
  await coord.fill('#fs-hasta', await coord.evaluate(() => hoy()));
  await coord.fill('#fs-motivo', 'Se cambió la correa en la vía');
  await coord.click('#fs-btn');
  await coord.waitForTimeout(1200);
  verificar('queda cerrado y ya no aparece como parado',
    !/Sigue fuera de servicio/i.test(await coord.locator('.modal-caja').innerText()));

  await ctxCond.close();
} finally {
  await ctxAdmin.close();
  await ctxCoord.close();
  await nav.close();
  servidor.kill();
}

console.log(`\n${pruebas - fallos}/${pruebas} comprobaciones correctas`);
if (fallos) { console.log(`${fallos} FALLO(S)`); process.exit(1); }
