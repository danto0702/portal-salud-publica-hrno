/**
 * Genera las capturas de los tres manuales.
 *
 * Se toman contra el SERVIDOR DE EJEMPLO, con sus datos inventados, NUNCA
 * contra la base de producción: un manual lleva nombres, placas y cédulas en
 * cada pantalla, y eso no puede salir de la operación real.
 *
 *   node manuales/capturas.mjs
 *
 * El servidor lo levanta y lo apaga este mismo archivo. El prefijo de cada
 * captura dice a qué manual pertenece: cond-, coord- o admin-.
 *
 * El orden importa: coordinación deja una solicitud pendiente que el manual
 * del administrador necesita para poder enseñar la bandeja con algo dentro.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const RAIZ = path.join(AQUI, '..');
const DESTINO = path.join(AQUI, 'img');
const PUERTO = Number(process.env.PUERTO ?? (8800 + (process.pid % 300)));
const BASE = `http://127.0.0.1:${PUERTO}`;

fs.mkdirSync(DESTINO, { recursive: true });

// Hora de Colombia: el servidor siembra el día operativo colombiano y el
// navegador pinta el día del reloj del equipo. Sin esto, de noche las capturas
// salen con la programación del día siguiente, casi siempre vacía.
const COMUN = { locale: 'es-CO', timezoneId: 'America/Bogota', deviceScaleFactor: 2 };
const TELEFONO = {
  ...COMUN, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/126 Mobile Safari/537.36',
};
const ESCRITORIO = { ...COMUN, viewport: { width: 1320, height: 840 } };

/** JPEG de 1x1. La fotografía es obligatoria en cada marca; para una captura
 *  da igual qué se vea en ella, lo que importa es la pantalla que queda. */
const FOTO = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof'
  + 'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAA'
  + 'AAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const servidor = spawn('node', [path.join(RAIZ, 'worker/pruebas/servidor_local.mjs')],
  { env: { ...process.env, PUERTO: String(PUERTO) }, stdio: 'ignore' });
const dormir = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try { await fetch(`${BASE}/api/salud`); break; } catch { await dormir(250); }
}

const nav = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

let hechas = 0;
/** @param sel  recorta a ese elemento; sin él, toma la pantalla visible. */
async function guardar(pag, archivo, sel) {
  const destino = path.join(DESTINO, archivo + '.png');
  const blanco = sel ? pag.locator(sel).first() : pag;
  if (sel) await blanco.waitFor({ state: 'visible' });
  await blanco.screenshot({ path: destino });
  hechas++;
  console.log(`  ${archivo.padEnd(32)} ${(fs.statSync(destino).size / 1024).toFixed(0)} KB`);
}

async function sesion(ctxOpc, usuario, clave) {
  const ctx = await nav.newContext({ ...ctxOpc, permissions: ['geolocation'],
                                     geolocation: { latitude: 8.0775, longitude: -73.2236 } });
  const pag = await ctx.newPage();
  await pag.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  if (usuario) {
    await pag.fill('#in-usuario', usuario);
    await pag.fill('#in-clave', clave);
    await pag.click('#in-btn');
    await pag.waitForSelector('#app:not([hidden])');
    await pag.waitForTimeout(1700);
  }
  return { ctx, pag };
}

const ir = async (pag, vista, espera) => {
  await pag.evaluate(v => ir(v), vista);
  if (espera) await pag.waitForSelector(espera);
  await pag.waitForTimeout(1500);
};
const cerrar = async (pag) => {
  await pag.evaluate(() => cerrarModal());
  await pag.waitForSelector('#modal.on', { state: 'detached' }).catch(() => {});
  await pag.waitForFunction(() => !document.querySelector('#modal.on'));
  await pag.waitForTimeout(350);
};

try {
  // ══ CONDUCTOR ══════════════════════════════════════════════════════════
  console.log('\n── Manual del conductor ──────────────────────────────');
  {
    const { ctx, pag } = await sesion(TELEFONO, null);
    await guardar(pag, 'cond-01-ingreso', '#ingreso .caja');
    await ctx.close();
  }
  {
    const { ctx, pag } = await sesion(TELEFONO, 'jnavarro', 'Conductor2026');
    await guardar(pag, 'cond-02-mi-dia');

    await pag.click('button:has-text("REGISTRAR SALIDA")');
    await pag.waitForSelector('.modal-caja');
    await pag.waitForTimeout(1500);
    await guardar(pag, 'cond-03-salida', '.modal-caja');
    await cerrar(pag);

    // El checklist, que es lo que se diligencia antes de arrancar.
    await pag.click('button:has-text("Diligenciar checklist")');
    await pag.waitForSelector('.modal-caja.on, #modal.on');
    await pag.waitForTimeout(1100);
    await guardar(pag, 'cond-04-checklist', '.modal-caja');
    await cerrar(pag);

    // Viaje EN CURSO y viaje CERRADO. La marca se hace por la API, con la
    // misma petición que manda el formulario: pasar por la cámara y por
    // Timemark no se puede automatizar, y lo que el manual tiene que enseñar
    // es la pantalla que queda, no el camino hasta ella.
    await pag.evaluate(foto => api('/api/trayectos/salida', { metodo: 'POST', cuerpo: {
      vehiculo_id: diaActual.vehiculo_id, municipio_id: 1, lugar: 'BASE ÁBREGO',
      km_inicial: 148320, num_tripulantes: 3,
      tripulantes: 'ANA GÓMEZ, LUIS PEÑA, MARTA SUÁREZ',
      lat: 8.0775, lon: -73.2236, precision: 12,
      foto: { mime: 'image/jpeg', datos: foto },
    } }), FOTO);
    await pag.evaluate(() => verHoy());
    await pag.waitForTimeout(1600);
    await guardar(pag, 'cond-05-en-curso');

    const idViaje = await pag.evaluate(() => api('/api/mi-dia').then(d => d.trayectos[0].id));
    await pag.evaluate(([id, foto]) => api(`/api/trayectos/${id}/llegada`, {
      metodo: 'POST', cuerpo: {
        municipio_id: 1, lugar: 'CAPITANLARGO', km_final: 148398,
        lat: 8.1102, lon: -73.2640, precision: 14,
        foto: { mime: 'image/jpeg', datos: foto },
      } }), [idViaje, FOTO]);
    await pag.evaluate(() => verHoy());
    await pag.waitForTimeout(1600);
    await guardar(pag, 'cond-06-cerrado');

    // Declarar el vehículo averiado.
    await pag.evaluate(() => modalAveriaConductor());
    await pag.waitForSelector('#av-desc');
    await pag.waitForTimeout(900);
    await guardar(pag, 'cond-07-averia', '.modal-caja');
    await cerrar(pag);

    await ir(pag, 'miItinerario', '#main');
    await guardar(pag, 'cond-08-mi-itinerario');

    await ir(pag, 'eventos', '#main');
    await guardar(pag, 'cond-09-novedades');
    await pag.click('button:has-text("Reportar novedad")');
    await pag.waitForSelector('.modal-caja');
    await pag.waitForTimeout(900);
    await guardar(pag, 'cond-10-reportar-novedad', '.modal-caja');
    await cerrar(pag);
    await ctx.close();
  }

  // ══ COORDINACIÓN ═══════════════════════════════════════════════════════
  console.log('\n── Manual de coordinación ────────────────────────────');
  let fechaPedida = null;
  {
    const { ctx, pag } = await sesion(ESCRITORIO, 'coordina', 'Coordina2026');
    await pag.waitForSelector('#itin-env');
    await pag.waitForTimeout(1400);
    await guardar(pag, 'coord-01-itinerario');

    // Adjudicar: la ventana que se abre al tocar una casilla libre. Se abre
    // llamando a la función, no con un clic: en la matriz el mismo gesto
    // arranca el arrastre, y a veces se traga el clic. Para una captura lo
    // que importa es la ventana, no cómo se llegó a ella.
    const libre = await pag.evaluate(() => {
      const c = document.querySelector('.itin-celda.vacia');
      return c ? { v: Number(c.dataset.vehiculoId), f: c.dataset.fecha } : null;
    });
    if (!libre) throw new Error('los datos de ejemplo no dejaron ninguna casilla libre');
    await pag.evaluate(x => modalItinerario(null, x.v, x.f), libre);
    await pag.waitForSelector('.modal-caja.on, .modal.on');
    await pag.waitForTimeout(900);
    await guardar(pag, 'coord-02-adjudicar', '.modal-caja');
    await pag.selectOption('#it-tipo', 'ebs');
    await pag.fill('#it-dest', 'LA SIERRA');
    await pag.click('#it-btn');
    await pag.waitForTimeout(2200);
    await cerrar(pag);
    fechaPedida = libre.f;

    // La casilla queda «esperando aprobación»: eso es lo que hay que explicar.
    // Se toma la pantalla, no la matriz entera: el aviso sale abajo y la
    // casilla arriba, y en la pantalla caben los dos.
    await guardar(pag, 'coord-03-esperando');

    // El pincel encendido, con su barra. El predeterminado lo crea el
    // ADMINISTRADOR: desde D41, si lo creara coordinación quedaría esperando
    // aprobación y no habría ninguna ficha que encender.
    {
      const a = await sesion(ESCRITORIO, 'danilo', 'Demo2026Clave');
      await a.pag.evaluate(() => api('/api/predeterminados', { metodo: 'POST', cuerpo: {
        nombre: 'EBS La Sierra', tipo_jornada: 'ebs', destino_nombre: 'LA SIERRA' } })
        .catch(e => { if (!/Ya existe/i.test(e.message)) throw e; }));
      await a.ctx.close();
    }
    await pag.evaluate(() => verItinerario());
    await pag.waitForTimeout(1600);
    await pag.waitForSelector('.pincel-chip');
    await pag.locator('.pincel-chip').first().click();
    await pag.waitForTimeout(900);
    await guardar(pag, 'coord-04-pincel');
    await pag.locator('#barra-pincel button:has-text("Apagar")').click();
    await pag.waitForTimeout(500);

    await pag.evaluate(() => modalRecientes());
    await pag.waitForSelector('.modal-caja');
    await pag.waitForTimeout(1200);
    await guardar(pag, 'coord-05-creado-hace-poco', '.modal-caja');
    await cerrar(pag);

    await ir(pag, 'solicitudes', '#main .card');
    await guardar(pag, 'coord-06-mis-solicitudes', '#main');

    await ir(pag, 'trayectos', '#tray-tabla');
    await guardar(pag, 'coord-07-viajes');

    await ir(pag, 'eventos', '#main');
    await guardar(pag, 'coord-08-novedades');

    await ir(pag, 'dashboard', '#main');
    await guardar(pag, 'coord-09-dashboard');
    await ctx.close();
  }
  {
    // La vista por día, que es como se programa desde el teléfono.
    const { ctx, pag } = await sesion(TELEFONO, 'coordina', 'Coordina2026');
    await ir(pag, 'itinerario', '#itin-env, #itin-dia');
    await pag.evaluate(() => { modoItin = 'dia'; verItinerario(); });
    await pag.waitForSelector('#itin-dia');
    await pag.waitForTimeout(1500);
    await guardar(pag, 'coord-10-vista-dia');
    await ctx.close();
  }

  // ══ ADMINISTRADOR ══════════════════════════════════════════════════════
  console.log('\n── Manual del administrador ──────────────────────────');
  {
    const { ctx, pag } = await sesion(ESCRITORIO, 'danilo', 'Demo2026Clave');
    await guardar(pag, 'admin-01-solicitudes', '#main');

    await pag.locator('#main button:has-text("Rechazar")').first().click();
    await pag.waitForSelector('#rech-motivo', { state: 'visible' });
    await pag.waitForTimeout(700);
    await guardar(pag, 'admin-02-rechazar', '.modal-caja');
    await cerrar(pag);

    await ir(pag, 'trayectos', '#tray-tabla');
    await guardar(pag, 'admin-03-viajes');

    // Corregir un viaje.
    const idEd = await pag.evaluate(() =>
      trayectosCargados.find(t => t.estado === 'cerrado')?.id);
    await pag.evaluate(id => modalEditarTrayecto(id), idEd);
    await pag.waitForSelector('#ed-btn');
    await pag.waitForTimeout(900);
    await guardar(pag, 'admin-04-corregir-viaje', '.modal-caja');
    await cerrar(pag);

    // El informe firmado.
    await pag.click('button:has-text("Informe")');
    await pag.waitForSelector('#inf-firmantes');
    await pag.waitForTimeout(900);
    await guardar(pag, 'admin-05-informe', '.modal-caja');
    await pag.fill('#inf-desde', await pag.evaluate(() => nDias(hoy(), -30)));
    await pag.fill('#inf-firmantes [data-rotulo]', 'Elaboró y aprobó');
    await pag.click('#inf-btn');
    await pag.waitForTimeout(3500);
    await cerrar(pag);

    await pag.setViewportSize({ width: 1600, height: 840 });
    await pag.click('button:has-text("Emitidos")');
    await pag.waitForSelector('.modal-caja');
    await pag.waitForTimeout(1200);
    await guardar(pag, 'admin-06-emitidos', '.modal-caja');
    await pag.locator('.modal-caja button:has-text("Reemitir")').first().click();
    await pag.waitForSelector('#rm-motivo');
    await pag.waitForTimeout(900);
    await guardar(pag, 'admin-07-reemitir', '.modal-caja');
    await cerrar(pag);
    await pag.setViewportSize(ESCRITORIO.viewport);

    await ir(pag, 'dashboard', '#main');
    await guardar(pag, 'admin-08-dashboard');

    await ir(pag, 'vehiculos', '#main table');
    await guardar(pag, 'admin-09-vehiculos');
    await pag.locator('#main button:has-text("Averías")').first().click();
    await pag.waitForSelector('.modal-caja');
    await pag.waitForTimeout(1200);
    await guardar(pag, 'admin-10-averias', '.modal-caja');
    await cerrar(pag);

    await ir(pag, 'personas', '#main table');
    await guardar(pag, 'admin-11-personas');
    await pag.locator('#main button:has-text("Editar")').first().click();
    await pag.waitForSelector('#p-cargo');
    await pag.waitForTimeout(800);
    await guardar(pag, 'admin-12-persona-cargo', '.modal-caja');
    await cerrar(pag);

    await ir(pag, 'usuarios', '#main table');
    await guardar(pag, 'admin-13-usuarios');

    await ir(pag, 'ajustes', '#main');
    await guardar(pag, 'admin-14-ajustes');

    await pag.setViewportSize({ width: 1600, height: 840 });
    await pag.evaluate(() => verAuditoria());
    await pag.waitForSelector('.modal-caja');
    await pag.waitForTimeout(1400);
    await guardar(pag, 'admin-15-auditoria', '.modal-caja');
    await cerrar(pag);
    await ctx.close();
  }
} finally {
  await nav.close();
  servidor.kill();
}

// ── Adelgazar los PNG ───────────────────────────────────────────────────────
// Una captura de pantalla tiene pocos colores planos: con una paleta de 255 y
// SIN tramado pesa un tercio y se ve igual —el texto no pierde un píxel—. Con
// tramado el fondo gris sale moteado, que es peor que el peso.
//
// Si ImageMagick no está, se dejan como salieron: adelgazarlas es una mejora,
// no un requisito, y el guion no debe fallar por eso.
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('convert', ['-version'], { stdio: 'ignore' });
  let antes = 0, despues = 0;
  for (const f of fs.readdirSync(DESTINO).filter(x => x.endsWith('.png'))) {
    const ruta = path.join(DESTINO, f);
    antes += fs.statSync(ruta).size;
    execFileSync('convert', [ruta, '-strip', '+dither', '-colors', '255', `PNG8:${ruta}`]);
    despues += fs.statSync(ruta).size;
  }
  console.log(`\n  adelgazadas: ${(antes / 1048576).toFixed(1)} MB -> `
            + `${(despues / 1048576).toFixed(1)} MB`);
} catch {
  console.log('\n  (sin ImageMagick: las capturas quedan sin adelgazar)');
}

console.log(`\n${hechas} capturas en manuales/img/\n`);
