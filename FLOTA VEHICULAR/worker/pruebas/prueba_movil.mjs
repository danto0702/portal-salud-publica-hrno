/**
 * Prueba de que el itinerario se puede PROGRAMAR desde el teléfono.
 *
 * Se reportó que en el celular la pantalla de administración no dejaba
 * modificar itinerarios: por debajo de 700 px la matriz se sustituía por una
 * lista que solo mostraba los días YA programados, así que los vehículos
 * libres no salían y no había dónde tocar para adjudicar un traslado.
 *
 * Todo lo de aquí corre en un navegador de verdad a 412 px de ancho, contra
 * el Worker real y una base de ejemplo: una prueba que solo mirara el código
 * no habría visto el defecto, porque el código de la matriz siempre estuvo
 * bien — lo que estaba mal era cuál de las dos vistas se dibujaba.
 *
 *   node worker/pruebas/prueba_movil.mjs
 *
 * Playwright no es dependencia de la aplicación. Si no está instalado, la
 * prueba se salta entera.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(AQUI, '../..');            // carpeta FLOTA VEHICULAR
const PUERTO = Number(process.env.PUERTO) || 8792;
const BASE = `http://127.0.0.1:${PUERTO}`;

let fallos = 0, pruebas = 0;
function verificar(nombre, condicion, detalle) {
  pruebas++;
  if (condicion) return console.log(`  OK  ${nombre}`);
  fallos++;
  console.log(`  MAL ${nombre}${detalle ? ' — ' + detalle : ''}`);
}

let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright')); }
catch {
  console.log('(sin Playwright: se salta la prueba del itinerario en el celular)');
  process.exit(0);
}

// La base se siembra con el día operativo colombiano; sin esta zona horaria,
// de noche el navegador pinta el día siguiente y no cuadra nada.
const TEL = {
  locale: 'es-CO', timezoneId: 'America/Bogota',
  viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true,
  deviceScaleFactor: 1,
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
const ctx = await nav.newContext(TEL);
const pag = await ctx.newPage();
const errores = [];
pag.on('pageerror', e => errores.push(e.message));

try {
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await pag.fill('#in-usuario', 'coordina');
  await pag.fill('#in-clave', 'Coordina2026');
  await pag.click('#in-btn');
  await pag.waitForSelector('#app:not([hidden])');
  await pag.click('.nav button:has-text("Itinerario")');
  await pag.waitForSelector('#main .cab h1:has-text("Itinerario")');
  await pag.waitForTimeout(600);

  // ── La matriz, igual que en el escritorio ────────────────────────────────
  console.log('\n══ El teléfono entra en la matriz, como el escritorio ══');

  verificar('en el celular sale la matriz, no una lista de solo lectura',
    await pag.locator('#itin-env table').count() === 1);
  const vacias = await pag.locator('.itin-celda.vacia').count();
  verificar('hay casillas libres donde tocar para adjudicar', vacias > 0, `${vacias}`);
  verificar('la columna de placas se queda fija al desplazar',
    await pag.locator('.itin-th-veh').count() === 1);

  // La matriz se desplaza DENTRO de su marco. Si se desbordara la página, el
  // dedo movería la pantalla entera y la cabecera se iría de lado.
  const anchoPag = await pag.evaluate(() => document.documentElement.scrollWidth);
  verificar('la página no se desborda de lado', anchoPag <= 414, `${anchoPag} px`);
  const env = await pag.evaluate(() => {
    const e = document.querySelector('#itin-env');
    return { visible: e.clientWidth, total: e.scrollWidth };
  });
  verificar('la matriz sí se desplaza de lado dentro de su marco', env.total > env.visible);

  const cols = await pag.locator('#itin-env thead th').count() - 1;
  verificar('arranca en una semana, para reducir el desplazamiento', cols === 7, `${cols} días`);

  // ── Adjudicar tocando una casilla libre ──────────────────────────────────
  console.log('\n══ Adjudicar un traslado desde el teléfono ══');

  // Un vehículo con dos días libres: uno para adjudicar y otro al que moverlo.
  const elegido = await pag.evaluate(() => {
    const porVeh = {};
    for (const c of document.querySelectorAll('.itin-celda.vacia')) {
      (porVeh[c.dataset.vehiculoId] ??= []).push(c.dataset.fecha);
    }
    const v = Object.keys(porVeh).find(k => porVeh[k].length >= 2);
    return v ? { veh: v, fec: porVeh[v][0] } : null;
  });
  verificar('hay un vehículo con dos días libres para la prueba', !!elegido);
  const { veh, fec } = elegido;

  await pag.locator(`.itin-celda.vacia[data-vehiculo-id="${veh}"][data-fecha="${fec}"]`).click();
  await pag.waitForSelector('.modal-caja');
  verificar('se abre la ventana para adjudicar',
    /Adjudicar desplazamiento/.test(await pag.locator('.modal-caja').innerText()));
  await pag.selectOption('#it-tipo', 'ebs');
  await pag.fill('#it-dest', 'Prueba Celular');
  await pag.click('#it-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(800);

  const celda = pag.locator(`.itin-celda[data-vehiculo-id="${veh}"][data-fecha="${fec}"]`);
  // El servidor guarda los destinos en mayúsculas.
  verificar('el traslado queda adjudicado y se ve en la matriz del teléfono',
    /^prueba celular$/i.test((await celda.locator('.dest').innerText()).trim()));

  // ── Mover sin arrastrar el dedo ──────────────────────────────────────────
  console.log('\n══ Mover a otro día sin arrastrar el dedo ══');

  await celda.click();
  await pag.waitForSelector('.modal-caja');
  verificar('la ventana ofrece mover a otro día o vehículo',
    await pag.locator('.mover-bloque').count() === 1);
  await pag.locator('.mover-bloque summary').click();

  const destino = await pag.evaluate(v => document.querySelector(
    `.itin-celda.vacia[data-vehiculo-id="${v}"]`)?.dataset.fecha, veh);
  verificar('hay otro día libre del mismo vehículo al que moverlo', !!destino);
  await pag.fill('#it-fecha', destino);
  await pag.waitForTimeout(200);
  verificar('avisa que el día escogido está libre',
    /libre/i.test(await pag.locator('#it-mover-avi').innerText()));
  await pag.click('#it-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(800);

  verificar('la programación aparece en el día nuevo',
    /^prueba celular$/i.test((await pag.locator(
      `.itin-celda[data-vehiculo-id="${veh}"][data-fecha="${destino}"] .dest`).innerText()).trim()));
  verificar('y el día de origen queda libre otra vez',
    await pag.locator(`.itin-celda[data-vehiculo-id="${veh}"][data-fecha="${fec}"].vacia`).count() === 1);

  // ── El aviso de intercambio ──────────────────────────────────────────────
  console.log('\n══ Avisa antes de intercambiar dos programaciones ══');

  // El día de origen quedó libre al mover: se le pone algo para tener un
  // destino ocupado y SIN viajes registrados. Uno ya ejecutado no se puede
  // ocupar, y el aviso sería el otro.
  await pag.evaluate(([v, f]) => api('/api/itinerario', {
    metodo: 'POST',
    cuerpo: { fecha: f, vehiculo_id: Number(v), tipo_jornada: 'ebs', destino_nombre: 'Estorbo' },
  }), [veh, fec]);
  await pag.evaluate(() => verItinerario());
  await pag.waitForSelector('#itin-env');
  await pag.waitForTimeout(600);

  await pag.locator(`.itin-celda[data-vehiculo-id="${veh}"][data-fecha="${destino}"]`).click();
  await pag.waitForSelector('.modal-caja');
  await pag.locator('.mover-bloque summary').click();
  await pag.fill('#it-fecha', fec);
  await pag.waitForTimeout(200);
  verificar('avisa que las dos se intercambian de sitio',
    /INTERCAMBIAN/.test(await pag.locator('#it-mover-avi').innerText()));
  await pag.click('.modal-pie .btn.sec:has-text("Cerrar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });

  // ── La vista por día ─────────────────────────────────────────────────────
  console.log('\n══ La vista por día, con TODOS los vehículos ══');

  await pag.click('#main .cab button:has-text("Ver por día")');
  await pag.waitForSelector('#itin-dia');
  const activos = await pag.evaluate(() => vehiculos.filter(v => v.activo !== 0).length);
  verificar('salen todos los vehículos, programados y libres',
    await pag.locator('#itin-dia .itin-ren').count() === activos, `de ${activos}`);
  verificar('los libres salen como ranura «+ Asignar»',
    await pag.locator('#itin-dia .itin-ren.libre').count() > 0);
  verificar('la vista por día no se desborda de lado',
    await pag.evaluate(() => document.documentElement.scrollWidth) <= 414);
  verificar('la tira de días cubre el período',
    await pag.locator('.tira-dias .d').count() === 7);

  const renLibre = pag.locator('#itin-dia .itin-ren.libre').first();
  const veh2 = await renLibre.getAttribute('data-vehiculo-id');
  await renLibre.click();
  await pag.waitForSelector('.modal-caja');
  await pag.selectOption('#it-tipo', 'vacunacion');
  await pag.fill('#it-dest', 'Desde la lista');
  await pag.click('#it-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(800);
  const ren2 = pag.locator(`#itin-dia .itin-ren[data-vehiculo-id="${veh2}"]`);
  verificar('la ranura queda ocupada tras adjudicar desde la vista por día',
    !(await ren2.getAttribute('class')).includes('libre'));
  verificar('y muestra el destino que se escribió',
    /desde la lista/i.test(await ren2.innerText()));

  await pag.locator('.tira-dias .d').nth(3).click();
  await pag.waitForSelector('#itin-dia');
  verificar('al cambiar de día queda uno solo señalado',
    await pag.locator('.tira-dias .d.on').count() === 1);
  verificar('y el día nuevo también trae todos los vehículos',
    await pag.locator('#itin-dia .itin-ren').count() === activos);

  // ── El pincel, por toques ────────────────────────────────────────────────
  console.log('\n══ El pincel de predeterminados en el teléfono ══');

  // La base de ejemplo no trae predeterminados: se crea uno para la prueba.
  await pag.evaluate(() => api('/api/predeterminados', {
    metodo: 'POST',
    cuerpo: { nombre: 'Pincel prueba', tipo_jornada: 'jornada', destino_nombre: 'Pintado' },
  }));
  await pag.evaluate(() => verItinerario());
  await pag.waitForSelector('#itin-dia');
  await pag.waitForTimeout(500);
  const hayLibres = await pag.evaluate(() => {
    const total = vehiculos.filter(v => v.activo !== 0).length;
    const d = [...document.querySelectorAll('.tira-dias .d')]
      .find(d => Number(d.querySelector('.c').textContent) < total);
    if (d) d.click();
    return !!d;
  });
  await pag.waitForTimeout(500);
  verificar('las fichas del pincel ya no se esconden en el celular',
    await pag.locator('.pincel-chip').count() > 0);
  const antesLibres = await pag.locator('#itin-dia .itin-ren.libre').count();
  verificar('hay un día con ranuras libres para pintar', hayLibres && antesLibres > 0);

  await pag.locator('.pincel-chip').first().click();
  await pag.locator('#itin-dia .itin-ren.libre').first().click();
  await pag.waitForTimeout(1400);
  verificar('un toque con el pincel programa el día, sin abrir ventana',
    await pag.locator('#itin-dia .itin-ren.libre').count() === antesLibres - 1);
  verificar('y no se abrió ninguna ventana',
    await pag.locator('.modal-caja:visible').count() === 0);
  await pag.locator('.pincel-chip.activo').first().click();   // apagar

  // ── Lo que se recuerda, y el escritorio ──────────────────────────────────
  console.log('\n══ Se recuerda la elección; el escritorio queda igual ══');

  verificar('se recuerda que dejó puesta la vista por día',
    await pag.evaluate(() => localStorage.getItem('flota_itin_modo')) === 'dia');
  await pag.setViewportSize({ width: 1280, height: 800 });
  await pag.waitForTimeout(600);
  verificar('en pantalla ancha vuelve la matriz aunque estuviera en vista por día',
    await pag.locator('#itin-env table').count() === 1);
  verificar('y el botón de alternar no estorba en el escritorio',
    await pag.locator('#main .cab button:has-text("Ver por día")').count() === 0);

  // ── Que el escritorio no se haya roto por el camino ─────────────────────
  // La matriz del celular es la MISMA del escritorio: al retocarla —la columna
  // de placas pasó a CSS, y el pincel dejó de pintar arrastrando con el dedo—
  // se pudo romper el arrastre con el ratón, que es como se programa a diario.
  console.log('\n══ Con ratón, en pantalla ancha, todo sigue igual ══');

  await pag.evaluate(() => { modoItin = 'matriz'; verItinerario(); });
  await pag.waitForSelector('#itin-env');
  await pag.waitForTimeout(700);

  // Origen sin viajes y destino libre que esté DENTRO de la pantalla: el ratón
  // no puede soltar sobre una celda que está fuera.
  const caso = await pag.evaluate(() => {
    const it = itinDatos.find(x => !x.trayectos_cerrados && x.estado !== 'cancelado');
    if (!it) return null;
    const libre = [...document.querySelectorAll(
        `.itin-celda.vacia[data-vehiculo-id="${it.vehiculo_id}"]`)]
      .find(c => { const r = c.getBoundingClientRect();
                   return r.left > 0 && r.right < window.innerWidth; });
    return libre ? { id: it.id, veh: it.vehiculo_id, hasta: libre.dataset.fecha } : null;
  });
  verificar('hay un caso de arrastre que probar', !!caso);
  if (caso) {
    const orig = pag.locator(`.itin-celda[data-itin-id="${caso.id}"]`);
    await orig.scrollIntoViewIfNeeded();
    await pag.waitForTimeout(200);
    const bo = await orig.boundingBox();
    const bd = await pag.locator(
      `.itin-celda.vacia[data-vehiculo-id="${caso.veh}"][data-fecha="${caso.hasta}"]`).boundingBox();
    await pag.mouse.move(bo.x + bo.width / 2, bo.y + bo.height / 2);
    await pag.mouse.down();
    await pag.mouse.move(bd.x + bd.width / 2, bd.y + bd.height / 2, { steps: 12 });
    await pag.mouse.up();
    await pag.waitForTimeout(1400);
    verificar('arrastrar con el ratón sigue moviendo la programación',
      await pag.locator(`.itin-celda[data-vehiculo-id="${caso.veh}"][data-fecha="${caso.hasta}"]`
        + `[data-itin-id="${caso.id}"]`).count() === 1);
  }

  const antesVacias = await pag.locator('.itin-celda.vacia').count();
  await pag.locator('.pincel-chip').first().click();
  const libres = await pag.locator('.itin-celda.vacia').all();
  const b1 = await libres[0].boundingBox(), b2 = await libres[1].boundingBox();
  await pag.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await pag.mouse.down();
  await pag.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 15 });
  await pag.mouse.up();
  await pag.waitForTimeout(1800);
  verificar('pintar arrastrando con el ratón sigue funcionando',
    await pag.locator('.itin-celda.vacia').count() < antesVacias);

  verificar('ninguna excepción en la consola', errores.length === 0, errores[0]);
} finally {
  await ctx.close();
  await nav.close();
  servidor.kill();
}

console.log(`\n${pruebas - fallos}/${pruebas} comprobaciones correctas`);
if (fallos) { console.log(`${fallos} FALLO(S)`); process.exit(1); }
