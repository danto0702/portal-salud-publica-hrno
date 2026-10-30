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

/** Entra con otra cuenta en la misma pestaña. */
async function entrar(usuario, clave) {
  await pag.evaluate(() => { try { salir(true); } catch { localStorage.clear(); } });
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await pag.fill('#in-usuario', usuario);
  await pag.fill('#in-clave', clave);
  await pag.click('#in-btn');
  await pag.waitForSelector('#app:not([hidden])');
}

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

  // ── Anular y borrar un viaje: solo el administrador ─────────────────────
  console.log('\n══ Quitar un viaje: solo el administrador ══');

  const unViaje = await pag.evaluate(() =>
    trayectosCargados.find(x => x.estado === 'cerrado'));
  await pag.evaluate(id => verTrayecto(id), unViaje.id);
  await pag.waitForSelector('.modal-caja');
  verificar('Coordinación no ve el botón de quitar',
    await pag.locator('.modal-pie button:has-text("Quitar este viaje")').count() === 0);
  verificar('ni la casilla de ver los anulados',
    await pag.locator('.marca-check:has-text("anulados")').count() === 0);
  await pag.click('.modal-pie .btn:has-text("Cerrar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });

  await entrar('danilo', 'Demo2026Clave');
  await pag.click('.nav button:has-text("Trayectos")');
  await pag.waitForSelector('#tray-tabla');
  await pag.waitForTimeout(900);
  const antes = await cuenta();
  verificar('el administrador sí ve la casilla de los anulados',
    await pag.locator('.marca-check:has-text("anulados")').count() === 1);

  await pag.evaluate(id => verTrayecto(id), unViaje.id);
  await pag.waitForSelector('.modal-caja');
  await pag.click('.modal-pie button:has-text("Quitar este viaje")');
  await pag.waitForSelector('#qt-motivo');
  verificar('la ventana avisa de lo que pasa con el día',
    /deja de ser pagable/i.test(await pag.locator('.modal-caja').innerText()));
  verificar('y ofrece borrar definitivamente como una casilla aparte',
    await pag.locator('#qt-definitivo').count() === 1
    && !await pag.isChecked('#qt-definitivo'));

  // Sin motivo no deja
  await pag.click('#qt-btn');
  await pag.waitForTimeout(400);
  verificar('sin motivo no deja quitarlo',
    await pag.locator('#qt-motivo').count() === 1);

  await pag.fill('#qt-motivo', 'Lo registró el conductor equivocado');
  await pag.click('#qt-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(1300);
  verificar('anulado, el viaje sale de la lista',
    await cuenta() === antes - 1, `${await cuenta()} contra ${antes - 1}`);

  await pag.check('.marca-check:has-text("anulados") input');
  await pag.waitForTimeout(1300);
  verificar('pero destapando los anulados vuelve a verse',
    await cuenta() === antes, `${await cuenta()} contra ${antes}`);
  verificar('y se ve tachado, para que no se confunda con uno que cuenta',
    await pag.locator('tr.fila-anulada').count() === 1);

  await pag.evaluate(id => verTrayecto(id), unViaje.id);
  await pag.waitForSelector('.modal-caja');
  const fichaAnulada = await pag.locator('.modal-caja').innerText();
  verificar('la ficha dice por qué se anuló',
    /lo registró el conductor equivocado/i.test(fichaAnulada));
  verificar('y quién lo hizo', /anulado por/i.test(fichaAnulada) && /danilo/.test(fichaAnulada));

  await pag.click('.modal-pie button:has-text("Deshacer la anulación")');
  await pag.waitForTimeout(1400);
  verificar('se puede deshacer',
    await pag.locator('tr.fila-anulada').count() === 0);

  await pag.uncheck('.marca-check:has-text("anulados") input');
  await pag.waitForTimeout(1300);
  verificar('y el viaje vuelve a contar', await cuenta() === antes, `${await cuenta()}`);

  // ── Corregir un viaje ──────────────────────────────────────────────────
  console.log('\n══ Corregir los datos de un viaje ══');

  const corregible = await pag.evaluate(() =>
    trayectosCargados.find(x => x.estado === 'cerrado' && x.km_final));
  await pag.evaluate(id => verTrayecto(id), corregible.id);
  await pag.waitForSelector('.modal-caja');
  verificar('el administrador ve el botón de corregir',
    await pag.locator('.modal-pie button:has-text("Corregir datos")').count() === 1);
  verificar('y el de ver las correcciones',
    await pag.locator('.modal-pie button:has-text("Correcciones")').count() === 1);

  await pag.click('.modal-pie button:has-text("Corregir datos")');
  await pag.waitForSelector('#ed-motivo');
  const forma = await pag.locator('.modal-caja').innerText();
  verificar('se advierte que esto cambia un soporte de pago',
    /soporte de pago/i.test(forma));
  verificar('y que las coordenadas y las fotos no se pueden cambiar',
    /no se pueden cambiar/i.test(forma));
  verificar('no hay campos de latitud ni longitud',
    await pag.locator('#ed-lat, #ed-lon').count() === 0);

  // La hora viene en la hora del equipo, no en UTC crudo.
  const horaForm = await pag.inputValue('#ed-ts-s');
  const horaReal = await pag.evaluate(id =>
    new Date(trayectosCargados.find(t => t.id === id).ts_salida)
      .toLocaleString('sv-SE').replace(' ', 'T').slice(0, 16), corregible.id);
  verificar('la hora de salida sale en la hora local, no en UTC',
    horaForm === horaReal, `${horaForm} contra ${horaReal}`);

  // Sin motivo no deja.
  await pag.fill('#ed-km-f', String(corregible.km_final + 7));
  await pag.click('#ed-btn');
  await pag.waitForTimeout(500);
  verificar('sin motivo no deja guardar', await pag.locator('#ed-motivo').count() === 1);

  // Kilometraje al revés: lo para la propia pantalla, sin ir al servidor.
  await pag.fill('#ed-motivo', 'Error al digitar el odómetro');
  await pag.fill('#ed-km-f', String((corregible.km_inicial || 0) - 50));
  await pag.click('#ed-btn');
  await pag.waitForTimeout(500);
  verificar('avisa si el kilometraje final queda por debajo del inicial',
    await pag.locator('#ed-motivo').count() === 1);

  // Mover el día avisa de lo que pasa con el pago.
  const otroDia = await pag.evaluate(f => nDias(f, -1), corregible.fecha_operacion);
  await pag.fill('#ed-km-f', String(corregible.km_final + 7));
  await pag.fill('#ed-fecha', otroDia);
  await pag.waitForTimeout(300);
  verificar('al mover el día se avisa que el día pagable se mueve con él',
    /día pagable se mueve/i.test(await pag.locator('#ed-aviso-dia').innerText()));
  await pag.fill('#ed-fecha', corregible.fecha_operacion);
  await pag.waitForTimeout(300);

  await pag.fill('#ed-lugar-l', 'LUGAR CORREGIDO');
  await pag.click('#ed-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(1400);
  const tras = await pag.evaluate(id => trayectosCargados.find(t => t.id === id), corregible.id);
  verificar('el dato queda corregido', tras.km_final === corregible.km_final + 7,
    `${tras.km_final} contra ${corregible.km_final + 7}`);
  verificar('y el lugar también', tras.lugar_llegada === 'LUGAR CORREGIDO', tras.lugar_llegada);

  await pag.evaluate(id => verCambiosTrayecto(id), corregible.id);
  await pag.waitForSelector('.modal-caja');
  await pag.waitForTimeout(600);
  const hist = await pag.locator('.modal-caja').innerText();
  verificar('el historial muestra la corrección', /Kilometraje final/i.test(hist), hist.slice(0, 120));
  verificar('con el motivo que se escribió', /odómetro/i.test(hist));
  verificar('y con quién la hizo', /danilo/i.test(hist));
  await pag.click('.modal-pie .btn:has-text("Cerrar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });

  // ── La auditoría distingue lo hecho en bloque ──────────────────────────
  // Sin esto no se podía saber de dónde salió programación que nadie esperaba:
  // el detalle se guardaba y nunca se mostraba.
  console.log('\n══ La auditoría muestra el detalle ══');
  await pag.evaluate(() => api('/api/itinerario/lote', { metodo: 'POST', cuerpo: {
    operaciones: [1, 2, 3].map(i => ({
      accion: 'crear', fecha: nDias(hoy(), 200 + i),
      vehiculo_id: vehiculos[0].id, tipo_jornada: 'ebs',
    })),
  } }));
  await pag.evaluate(() => verAuditoria());
  await pag.waitForSelector('.modal-caja');
  await pag.waitForTimeout(700);
  const aud = await pag.locator('.modal-caja').innerText();
  verificar('explica qué significa una línea sin número', /en bloque/i.test(aud));
  verificar('y la creación en bloque dice cuántas fueron',
    /3 creadas de un golpe/i.test(aud), aud.split('\n').slice(0, 12).join(' | '));
  verificar('la fila en bloque va señalada',
    await pag.locator('.modal-caja .etq.ambar:has-text("en bloque")').count() >= 1);
  await pag.click('.modal-pie .btn:has-text("Cerrar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });


  // ── El informe estadístico firmado (D42) ────────────────────────────────
  console.log('\n══ El informe firmado ══');

  await pag.click('.nav button:has-text("Trayectos")');
  await pag.waitForSelector('#tray-tabla');
  await pag.waitForTimeout(700);
  verificar('el administrador tiene el botón de informe',
    await pag.locator('button:has-text("Informe")').count() === 1);

  await pag.click('button:has-text("Informe")');
  await pag.waitForSelector('#inf-firmantes');
  await pag.waitForTimeout(400);
  const mInf = await pag.locator('.modal-caja').innerText();
  verificar('dice que las cifras las calcula el servidor, no la pantalla',
    /calcula el servidor/i.test(mInf), mInf.slice(0, 120));
  verificar('ofrece los administradores como firmantes',
    await pag.locator('#inf-firmantes input[type=checkbox]').count() >= 1);
  verificar('y viene uno marcado, para no emitir sin firma por descuido',
    await pag.locator('#inf-firmantes input[type=checkbox]:checked').count() === 1);
  verificar('el período arranca en el que se está viendo en Viajes',
    await pag.inputValue('#inf-desde') === await pag.inputValue('#tr-desde'));

  // Sin firmante no sale.
  await pag.locator('#inf-firmantes input[type=checkbox]').first().uncheck();
  await pag.click('#inf-btn');
  await pag.waitForTimeout(500);
  verificar('sin marcar a nadie no se emite',
    await pag.locator('#inf-firmantes').count() === 1
    && /firmante/i.test(await pag.locator('#avisos').innerText()),
    (await pag.locator('#avisos').innerText()).replace(/\n/g, ' ').slice(0, 80));

  await pag.locator('#inf-firmantes input[type=checkbox]').first().check();
  await pag.fill('#inf-firmantes [data-rotulo]', 'Elaboró y aprobó');
  await pag.fill('#inf-obs', 'Informe de prueba automática.');
  const [pdf] = await Promise.all([
    pag.waitForEvent('download'),
    pag.click('#inf-btn'),
  ]);
  const rutaPdf = path.join(descargas, pdf.suggestedFilename());
  await pdf.saveAs(rutaPdf);
  const bytes = fs.readFileSync(rutaPdf);
  verificar('se descarga un PDF de verdad',
    bytes.slice(0, 5).toString() === '%PDF-' && bytes.length > 4000, bytes.length);
  verificar('el archivo se llama con el número del informe',
    /^INF-\d{4}-\d{6}_/.test(pdf.suggestedFilename()), pdf.suggestedFilename());

  // El texto del PDF: basta con buscarlo en crudo para comprobar que lo que
  // tiene que constar en el papel está en el papel.
  const crudo = bytes.toString('latin1');
  const dice = (t) => crudo.includes(t) || crudo.includes([...t].join('\u0000'));
  verificar('el documento lleva el bloque de firmas',
    /FIRMAS/i.test(crudo) || dice('Firmas') || /F.{0,3}I.{0,3}R.{0,3}M.{0,3}A.{0,3}S/i.test(crudo));
  verificar('y el número de informe', /INF-\d{4}-\d{6}/.test(crudo));

  await pag.waitForTimeout(600);
  verificar('se avisa con el número que quedó emitido',
    /INF-\d{4}-\d{6}/.test(await pag.locator('#avisos').innerText()),
    (await pag.locator('#avisos').innerText()).replace(/\n/g, ' ').slice(0, 90));

  // ── Queda guardado y se vuelve a descargar ──────────────────────────────
  await pag.click('button:has-text("Emitidos")');
  await pag.waitForSelector('.modal-caja');
  await pag.waitForTimeout(600);
  const emitidos = await pag.locator('.modal-caja').innerText();
  verificar('el informe queda en la lista de emitidos',
    /INF-\d{4}-\d{6}/.test(emitidos), emitidos.split('\n').slice(0, 8).join(' | '));
  verificar('con quién firma y qué período cubre',
    /con anexo/i.test(emitidos) && /\d{4}-\d{2}-\d{2}/.test(emitidos));

  const [pdf2] = await Promise.all([
    pag.waitForEvent('download'),
    pag.click('.modal-caja button:has-text("Descargar")'),
  ]);
  await pdf2.saveAs(path.join(descargas, 'otra_vez.pdf'));
  verificar('se puede volver a descargar el mismo informe, con el mismo número',
    pdf2.suggestedFilename() === pdf.suggestedFilename(),
    [pdf.suggestedFilename(), pdf2.suggestedFilename()]);
  await pag.click('.modal-pie .btn:has-text("Cerrar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });


  // ── El cargo de una persona ─────────────────────────────────────────────
  // Es lo que sale impreso bajo la raya de firma del informe. Sin este campo
  // el formulario solo preguntaba si la persona conduce o va a bordo, y el
  // cargo se quedaba en el 'CONDUCTOR' que pone la base por omisión.
  console.log('\n══ El cargo de una persona ══');

  await pag.click('.nav button:has-text("Personas")');
  await pag.waitForSelector('#main h1:has-text("Personas")');
  await pag.waitForTimeout(600);
  verificar('la tabla de personas tiene columna de cargo',
    await pag.locator('#main thead th:has-text("Cargo")').count() === 1);

  await pag.click('button:has-text("Registrar persona")');
  await pag.waitForSelector('#p-cargo');
  const cargos = await pag.locator('#p-cargo option').allInnerTexts();
  verificar('el cargo ofrece Administrador', cargos.some(c => /^ADMINISTRADOR$/i.test(c.trim())),
    cargos.slice(0, 6));
  verificar('y Coordinador', cargos.some(c => /^COORDINADOR$/i.test(c.trim())));
  verificar('y sigue ofreciendo Conductor y Tripulante',
    cargos.some(c => /^CONDUCTOR$/i.test(c.trim()))
    && cargos.some(c => /^TRIPULANTE$/i.test(c.trim())));
  verificar('el cargo no se confunde con la función del viaje',
    /no es el cargo/i.test(await pag.locator('.modal-caja').innerText()));

  // Lo que no esté en la lista se puede escribir.
  verificar('el campo libre está escondido mientras no haga falta',
    !(await pag.locator('#p-cargo-otro').isVisible()));
  await pag.selectOption('#p-cargo', '__otro');
  await pag.waitForTimeout(200);
  verificar('al escoger «Otro» aparece dónde escribirlo',
    await pag.locator('#p-cargo-otro').isVisible());

  await pag.fill('#p-nom', 'ANA LUCÍA');
  await pag.fill('#p-ape', 'PEÑARANDA');
  await pag.fill('#p-doc', '1090987654');
  await pag.selectOption('#p-cargo', 'COORDINADOR');
  await pag.click('#p-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(1200);

  const filaAna = pag.locator('#main tbody tr:has-text("ANA LUCÍA")');
  verificar('la persona queda con el cargo que se le puso',
    /COORDINADOR/.test(await filaAna.innerText()), await filaAna.innerText());

  // Un cargo guardado antes que no está en la lista NO se pierde al editar:
  // cambiarle el teléfono a alguien no puede cambiarle el cargo en silencio.
  const idAna = await pag.evaluate(() =>
    personas.find(p => p.nombres === 'ANA LUCÍA').id);
  await pag.evaluate(id => api('/api/personas/' + id,
    { metodo: 'PUT', cuerpo: { cargo: 'REFERENTE DE SALUD AMBIENTAL' } }), idAna);
  await pag.evaluate(() => verPersonas());
  await pag.waitForTimeout(900);
  await pag.evaluate(id => modalPersona(id), idAna);
  await pag.waitForSelector('#p-cargo');
  verificar('un cargo que no está en la lista se conserva y sale escogido',
    await pag.inputValue('#p-cargo') === 'REFERENTE DE SALUD AMBIENTAL',
    await pag.inputValue('#p-cargo'));
  await pag.fill('#p-tel', '3151234567');
  await pag.click('#p-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(1000);
  verificar('y editar otro dato no se lo cambia',
    /REFERENTE DE SALUD AMBIENTAL/.test(await filaAna.innerText()), await filaAna.innerText());

  // ── Y llega hasta la firma del informe ──────────────────────────────────
  await pag.click('.nav button:has-text("Usuarios")');
  await pag.waitForSelector('#main h1:has-text("Usuarios")');
  await pag.waitForTimeout(600);
  await pag.click('button:has-text("Crear usuario")');
  await pag.waitForSelector('#u-persona');
  verificar('al vincular una persona a una cuenta se ve su cargo',
    /REFERENTE DE SALUD AMBIENTAL/.test(
      (await pag.locator('#u-persona option').allInnerTexts()).join(' | ')));
  await pag.selectOption('#u-rol', 'principal');
  await pag.waitForTimeout(200);
  verificar('se advierte que un administrador sin persona no puede firmar',
    /no puede firmar/i.test(await pag.locator('#u-persona-nota').innerText()),
    await pag.locator('#u-persona-nota').innerText());
  await pag.fill('#u-usuario', 'apenaranda');
  await pag.selectOption('#u-persona', String(idAna));
  await pag.fill('#u-clave', 'ClaveTemporal2026');
  await pag.click('#u-btn');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });
  await pag.waitForTimeout(1200);

  await pag.click('.nav button:has-text("Trayectos")');
  await pag.waitForSelector('#tray-tabla');
  await pag.waitForTimeout(700);
  await pag.click('button:has-text("Informe")');
  await pag.waitForSelector('#inf-firmantes');
  await pag.waitForTimeout(400);
  const listaFirm = await pag.locator('#inf-firmantes').innerText();
  verificar('la nueva administradora puede firmar, con su cargo y su cédula',
    /ANA LUC[IÍ]A/i.test(listaFirm) && /REFERENTE DE SALUD AMBIENTAL/.test(listaFirm)
    && /1090987654/.test(listaFirm), listaFirm.replace(/\n/g, ' ').slice(0, 200));
  verificar('y a quien le falte el cargo se le avisa antes de emitir',
    await pag.locator('.firmante-fila.incompleto').count() >= 1);
  await pag.click('.modal-pie .btn:has-text("Cancelar")');
  await pag.waitForSelector('.modal-caja', { state: 'hidden' });

  verificar('ninguna excepción en la consola', errores.length === 0, errores[0]);
} finally {
  await ctx.close();
  await nav.close();
  servidor.kill();
  fs.rmSync(descargas, { recursive: true, force: true });
}

console.log(`\n${pruebas - fallos}/${pruebas} comprobaciones correctas`);
if (fallos) { console.log(`${fallos} FALLO(S)`); process.exit(1); }
