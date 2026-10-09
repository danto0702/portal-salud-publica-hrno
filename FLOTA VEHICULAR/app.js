/**
 * FLOTA VEHICULAR HRNO — aplicación
 * ESE Hospital Regional Noroccidental · Coordinación de Salud Pública
 *
 * Una sola página, sin framework. Tres roles: principal, coordinación, conductor.
 */

// ── Configuración ────────────────────────────────────────────────────────────
// En producción la aplicación se publica en GitHub Pages y la API vive en
// Cloudflare, así que son dominios distintos. Al servirla localmente (servidor
// de pruebas) la API va en el mismo origen, y así no hay que configurar nada.
/**
 * Versión mínima del Worker que esta aplicación necesita.
 *
 * La aplicación se actualiza sola desde GitHub Pages, pero el Worker se publica
 * a mano en Cloudflare. Cuando quedan desfasados, el Worker viejo acepta las
 * peticiones e ignora en silencio lo que no entiende — un campo que no se
 * guarda y ningún mensaje de error. Por eso se comprueba y se avisa.
 */
const VERSION_API_REQUERIDA = 14;

const esLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const API = localStorage.getItem('flota_api') ||
            (esLocal ? location.origin : 'https://flota-hrno.danto0702.workers.dev');

const TIPOS_JORNADA = {
  ebs:             { et: 'Ruta EBS',       color: 'azul'   },
  jornada:         { et: 'Jornada',        color: 'morado' },
  vacunacion:      { et: 'Vacunación',     color: 'verde'  },
  disponible:      { et: 'Disponible',     color: 'gris'   },
  traslado_ciudad: { et: 'Fuera del área', color: 'ambar'  },
  administrativo:  { et: 'Administrativo', color: 'gris'   },
};

// Checklist: 5 distintivos del vehículo + 4 elementos.
const DISTINTIVOS = [
  ['lateral_izquierdo', 'Lateral izquierdo'],
  ['lateral_derecho',   'Lateral derecho'],
  ['frontal',           'Frontal'],
  ['trasero',           'Trasero'],
  ['techo',             'Techo'],
];
const ELEMENTOS = [
  ['bandera',            'Bandera'],
  ['chaleco',            'Chaleco'],
  ['carnet',             'Carnet'],
  ['carta_presentacion', 'Carta de presentación'],
];
const EST_DISTINTIVO = ['bueno', 'deteriorado', 'ausente', 'obstruido'];
const EST_ELEMENTO   = ['presente', 'deteriorado', 'ausente', 'vencido'];
const FALTANTES      = ['ausente', 'obstruido', 'vencido'];

const TIPOS_EVENTO = [
  ['varada', 'Varada o avería'], ['accidente', 'Accidente'], ['reten', 'Retén'],
  ['bloqueo_via', 'Bloqueo de vía'], ['derrumbe', 'Derrumbe'],
  ['orden_publico', 'Orden público'], ['negacion_paso', 'Negación de paso'],
  ['falla_comunicaciones', 'Falla de comunicaciones'], ['retraso', 'Retraso'],
  ['cancelacion', 'Cancelación'], ['tanqueo', 'Tanqueo'],
  ['mantenimiento', 'Mantenimiento'], ['novedad_distintivo', 'Novedad de distintivo'],
  ['otro', 'Otro'],
];

/**
 * Causas por las que un vehículo no pudo operar (D33).
 *
 * No son solo averías: un vehículo parado por SOAT vencido o retenido en un
 * retén cuesta los mismos días de operación que uno en el taller. Todas se
 * cuentan igual como días sin operar; la causa sirve para separarlas después
 * en el informe y para distinguir el mantenimiento programado del daño.
 */
const CAUSAS_FS = {
  averia:        { et: 'Avería o varada',        color: 'rojo'   },
  mantenimiento: { et: 'Mantenimiento programado', color: 'azul' },
  accidente:     { et: 'Accidente',              color: 'rojo'   },
  documentos:    { et: 'Documentos vencidos',    color: 'ambar'  },
  retenido:      { et: 'Retenido',               color: 'ambar'  },
  sin_conductor: { et: 'Sin conductor',          color: 'gris'   },
  otro:          { et: 'Otro',                   color: 'gris'   },
};
const causaEt = c => CAUSAS_FS[c]?.et || c;

// ── Estado ───────────────────────────────────────────────────────────────────
let sesion = null;
let cat = { municipios: [], destinos: [], ips: [] };
const BANNER_ANCHO = 2000, BANNER_ALTO = 289;
let banner = null;                       // { mime, datos } o null
let parametros = {};                     // clave -> valor, para la interfaz
let vehiculos = [], personas = [];
let vistaActual = '';
const graficas = {};

// ── Utilidades ───────────────────────────────────────────────────────────────
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoy = () => new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD local
const nDias = (f, n) => new Date(Date.parse(f + 'T12:00:00') + n * 864e5).toLocaleDateString('sv-SE');
const num = n => (n == null ? '—' : Number(n).toLocaleString('es-CO'));
const pesos = n => (n == null ? '—' : '$' + Math.round(n).toLocaleString('es-CO'));

function hora(iso) {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}
function fechaHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
/** Ancho por debajo del cual la matriz de 14 columnas queda incómoda. */
const angosta = () => window.innerWidth < 700;
/**
 * Pantalla táctil. Cambia las instrucciones que se dan en pantalla —tocar en
 * vez de arrastrar— y desactiva el pintado por arrastre, que con el dedo sería
 * el mismo gesto que desplazar la lista.
 */
const tactil = () => window.matchMedia?.('(pointer: coarse)').matches === true;
const par = (clave, pordefecto) => parametros[clave] ?? pordefecto;

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const diaSemana = f => DIAS[new Date(f + 'T12:00:00').getDay()];

function aviso(texto, clase, titulo) {
  const d = document.createElement('div');
  d.className = 'aviso ' + (clase || '');
  d.innerHTML = (titulo ? `<b>${esc(titulo)}</b>` : '') + esc(texto);
  $('#avisos').appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 300); }, 4200);
}

// ── Llamadas a la API ────────────────────────────────────────────────────────
/** Tras un cambio propio se actualiza el sello, para no avisarse a sí mismo. */
async function tocarSello() { selloDatos = await leerSello(); }

async function api(ruta, opciones = {}) {
  const cab = { 'Content-Type': 'application/json' };
  if (sesion?.token) cab.Authorization = 'Bearer ' + sesion.token;
  const res = await fetch(API + ruta, {
    method: opciones.metodo || 'GET',
    headers: cab,
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
  });
  let datos = {};
  try { datos = await res.json(); } catch { /* respuesta sin cuerpo */ }
  // Solo aquí se cierra la sesión: el servidor contestó y dijo que no vale. Un
  // fallo de red ni siquiera llega a esta línea —fetch lanza antes—, que es lo
  // que evita que quedarse sin señal le borre la sesión al conductor.
  if (res.status === 401 && sesion) { salir(true); throw new Error('Su sesión expiró'); }
  if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);
  return datos;
}

// ── Cola sin señal ───────────────────────────────────────────────────────────
// Las marcas tomadas sin cobertura se guardan aquí y se envían solas al volver.
// ── Almacén local: IndexedDB ─────────────────────────────────────────────────
//
// localStorage NO sirve para esto. Son unos 5 MB por sitio y una sola fotografía
// ocupa cerca de 200 KB una vez codificada; con cuatro o cinco marcas sin señal
// se llenaba, el navegador lanzaba un error de cuota y la marca se perdía sin
// que nadie se enterara. IndexedDB tiene espacio de sobra y es el sitio correcto
// para lo que aquí se guarda:
//
//   cola   las marcas tomadas sin señal, CON su fotografía, hasta que se envían.
//   caja   lo último que se alcanzó a bajar del servidor —catálogos, parámetros,
//          vehículos y el día del conductor—, para que la aplicación abra y sea
//          usable sin ninguna señal.
const BAUL = 'flota-local';
let baulAbierto = null;

function abrirBaul() {
  if (baulAbierto) return baulAbierto;
  baulAbierto = new Promise((listo, falla) => {
    const p = indexedDB.open(BAUL, 1);
    p.onupgradeneeded = () => {
      const db = p.result;
      if (!db.objectStoreNames.contains('cola')) db.createObjectStore('cola', { keyPath: 'local_id' });
      if (!db.objectStoreNames.contains('caja')) db.createObjectStore('caja', { keyPath: 'clave' });
    };
    p.onsuccess = () => listo(p.result);
    p.onerror = () => falla(p.error);
  });
  return baulAbierto;
}

/** Envuelve una operación de IndexedDB en una promesa. */
function pedir(peticion) {
  return new Promise((listo, falla) => {
    peticion.onsuccess = () => listo(peticion.result);
    peticion.onerror = () => falla(peticion.error);
  });
}

const baul = {
  async poner(almacen, valor) {
    const db = await abrirBaul();
    return pedir(db.transaction(almacen, 'readwrite').objectStore(almacen).put(valor));
  },
  async todos(almacen) {
    const db = await abrirBaul();
    return pedir(db.transaction(almacen, 'readonly').objectStore(almacen).getAll());
  },
  async obtener(almacen, clave) {
    const db = await abrirBaul();
    return pedir(db.transaction(almacen, 'readonly').objectStore(almacen).get(clave));
  },
  async quitar(almacen, clave) {
    const db = await abrirBaul();
    return pedir(db.transaction(almacen, 'readwrite').objectStore(almacen).delete(clave));
  },
};

// ── Caja: la última copia buena de lo que manda el servidor ──────────────────
//
// Sin esto la aplicación abre pero no sirve de nada: no sabe los municipios, ni
// los vehículos, ni qué le tocaba hoy al conductor. Se guarda cada vez que se
// baja con señal y se lee cuando no la hay.

async function guardarEnCaja(clave, valor) {
  try { await baul.poner('caja', { clave, valor, ts: Date.now() }); }
  catch { /* sin almacén, la aplicación sigue funcionando con señal */ }
}

async function leerDeCaja(clave) {
  try { return (await baul.obtener('caja', clave))?.valor ?? null; }
  catch { return null; }
}

/**
 * Baja algo del servidor y lo deja en la caja; si no hay señal, devuelve la
 * última copia buena. Devuelve { datos, deCaja } para poder avisarlo en pantalla.
 */
async function conRespaldo(clave, ruta) {
  try {
    const datos = await api(ruta);
    await guardarEnCaja(clave, datos);
    return { datos, deCaja: false };
  } catch (e) {
    if (!esFalloDeRed(e)) throw e;          // un 403 o un 500 no se disimulan
    const datos = await leerDeCaja(clave);
    if (datos == null) throw e;
    return { datos, deCaja: true };
  }
}

/**
 * ¿El error viene de que no hay señal, o el servidor contestó que no?
 *
 * La diferencia es la que evita el peor defecto que tuvo esta aplicación: al no
 * distinguirlos, un simple fallo de red se trataba como "su sesión expiró" y le
 * borraba la sesión al conductor. Quedaba en la pantalla de ingreso, sin poder
 * entrar porque entrar también necesita red.
 *
 * fetch solo rechaza cuando la petición no llegó a ninguna parte. Si el servidor
 * respondió —aunque sea 401 o 500— no rechaza, y eso NO es un fallo de red.
 */
const esFalloDeRed = e => e instanceof TypeError || e?.sinRed === true;

let pendientes = 0;            // marcas en la cola, para pintar sin consultar

const cola = {
  async leer() {
    try { return await baul.todos('cola'); } catch { return []; }
  },
  async agregar(m) {
    const marca = { ...m, local_id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6) };
    await baul.poner('cola', marca);
    await this.contar();
    return marca;
  },
  async contar() {
    pendientes = (await this.leer()).length;
    this.pintar();
    return pendientes;
  },
  pintar() {
    const n = $('#offline-n');
    if (n) n.textContent = pendientes;
    $('#barra-offline')?.classList.toggle('on', pendientes > 0 || !navigator.onLine);
  },
  async sincronizar() {
    const marcas = await this.leer();
    if (!marcas.length || !navigator.onLine || !sesion) return;
    try {
      // De a una y EN ORDEN. Con fotografía cada marca pesa, así una que falle no
      // arrastra a las demás; y el orden importa porque una llegada tomada sin
      // señal apunta al identificador LOCAL de su salida, que todavía no existía
      // en el servidor. Al enviar la salida, el servidor devuelve su id de
      // verdad; aquí se guarda la equivalencia y se le aplica a la llegada. Sin
      // esto el servidor no encontraría el viaje y la llegada se perdería.
      marcas.sort((a, b) => String(a.ts_dispositivo).localeCompare(String(b.ts_dispositivo)));
      const equivale = new Map();
      let enviadas = 0;
      for (const m of marcas) {
        const envio = { ...m };
        if (envio.hito === 'llegada' && equivale.has(envio.trayecto_id)) {
          envio.trayecto_id = equivale.get(envio.trayecto_id);
        }
        // Una llegada cuya salida sigue en el teléfono no se puede enviar todavía.
        if (envio.hito === 'llegada' && String(envio.trayecto_id).startsWith('l')) continue;

        const r = await api('/api/sync', { metodo: 'POST', cuerpo: { marcas: [envio] } });
        const res = r.resultados?.[0];
        if (res?.ok) {
          if (m.hito === 'salida' && res.id) equivale.set(m.local_id, res.id);
          await baul.quitar('cola', m.local_id);
          enviadas++;
        }
      }
      await this.contar();
      if (enviadas) {
        aviso(`${enviadas} marca(s) enviada(s) al recuperar la señal`, 'ok', 'Sincronizado');
        if (vistaActual === 'hoy') verHoy();
      }
    } catch { /* se reintenta en la próxima oportunidad */ }
  },
};
window.addEventListener('online', () => { cola.contar(); cola.sincronizar(); });
window.addEventListener('offline', () => cola.pintar());

// ── Ubicación ────────────────────────────────────────────────────────────────
// Se pide SOLO al marcar salida o llegada. Nunca hay rastreo en segundo plano.
function ubicacion() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({});
    const listo = p => resolve({
      lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy,
    });
    navigator.geolocation.getCurrentPosition(listo, () => resolve({}),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

// ── Sesión ───────────────────────────────────────────────────────────────────
async function entrar(ev) {
  ev.preventDefault();
  const btn = $('#in-btn'), err = $('#in-error');
  btn.disabled = true; btn.textContent = 'Entrando...'; err.style.display = 'none';
  try {
    const r = await api('/api/auth/login', {
      metodo: 'POST',
      cuerpo: { usuario: $('#in-usuario').value.trim(), clave: $('#in-clave').value },
    });
    sesion = { token: r.token, ...r.usuario };
    localStorage.setItem('flota_sesion', JSON.stringify(sesion));
    await iniciar();
  } catch (e) {
    err.textContent = e.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

function salir(expiro) {
  if (!expiro && sesion) api('/api/auth/logout', { metodo: 'POST' }).catch(() => {});
  sesion = null;
  localStorage.removeItem('flota_sesion');
  $('#app').hidden = true;
  $('#ingreso').style.display = 'flex';
  $('#in-clave').value = '';
  if (expiro) { $('#in-error').textContent = 'Su sesión expiró. Ingrese de nuevo.'; $('#in-error').style.display = 'block'; }
}

// ── Menú por rol ─────────────────────────────────────────────────────────────
const ico = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONOS = {
  hoy:        ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  itinerario: ico('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  miItinerario: ico('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 15h6"/>'),
  dashboard:  ico('<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-4"/>'),
  trayectos:  ico('<path d="M14 17H6V5h11l4 6v6h-3"/><circle cx="17.5" cy="17.5" r="2.5"/><circle cx="6.5" cy="17.5" r="2.5"/>'),
  eventos:    ico('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  vehiculos:  ico('<path d="M14 17H6V5h11l4 6v6h-3"/><circle cx="17.5" cy="17.5" r="2.5"/><circle cx="6.5" cy="17.5" r="2.5"/>'),
  personas:   ico('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/>'),
  usuarios:   ico('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  ajustes:    ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.6.76 1 1.4 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  auditoria:  ico('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15h6M9 11h3"/>'),
};
const VISTAS = {
  hoy:        { et: 'Mi día',      fn: () => verHoy() },
  miItinerario: { et: 'Mi itinerario', fn: () => verMiItinerario() },
  itinerario: { et: 'Itinerario',  fn: () => verItinerario() },
  dashboard:  { et: 'Dashboard',   fn: () => verDashboard() },
  trayectos:  { et: 'Trayectos',   fn: () => verTrayectos() },
  eventos:    { et: 'Novedades',   fn: () => verEventos() },
  vehiculos:  { et: 'Vehículos',   fn: () => verVehiculos() },
  personas:   { et: 'Personas',    fn: () => verPersonas() },
  usuarios:   { et: 'Usuarios',    fn: () => verUsuarios() },
  ajustes:    { et: 'Ajustes',     fn: () => verAjustes() },
};
const MENU = {
  conductor:    ['hoy', 'miItinerario', 'eventos'],
  coordinacion: ['itinerario', 'dashboard', 'trayectos', 'eventos', 'hoy'],
  principal:    ['itinerario', 'dashboard', 'trayectos', 'eventos', 'vehiculos', 'personas', 'usuarios', 'ajustes'],
};

/**
 * Vista pedida por un acceso directo del icono instalado (…/index.html?ir=hoy).
 *
 * Se comprueba contra el menú del rol: un conductor que llegue con ?ir=ajustes
 * —o con un enlace viejo— entra a su pantalla de siempre, no a un error.
 */
function vistaPedida() {
  const v = new URLSearchParams(location.search).get('ir');
  return v && MENU[sesion.rol].includes(v) ? v : null;
}

function ir(v) {
  vistaActual = v;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  VISTAS[v].fn();
}

async function iniciar() {
  $('#ingreso').style.display = 'none';
  $('#app').hidden = false;
  const rol = { principal: 'Administrador', coordinacion: 'Coordinación', conductor: 'Conductor' }[sesion.rol];
  $('#tb-rol').textContent = rol;

  $('#nav').innerHTML = MENU[sesion.rol].map(v =>
    `<button data-v="${v}" onclick="ir('${v}')">${ICONOS[v] || ''}${VISTAS[v].et}</button>`).join('');

  cola.contar();
  comprobarVersion();
  cargarBanner();

  // Catálogos, parámetros y vehículos van con respaldo: con señal se bajan y se
  // guardan; sin señal se usa la última copia buena. Sin esto la aplicación
  // abría pero no sabía ni los municipios ni los vehículos, y el formulario de
  // marca salía vacío — que para el conductor es lo mismo que no funcionar.
  try { cat = (await conRespaldo('catalogos', '/api/catalogos')).datos; }
  catch { /* se reintenta luego */ }
  try {
    const { datos } = await conRespaldo('parametros', '/api/parametros');
    parametros = Object.fromEntries(datos.map(p => [p.clave, p.valor]));
  } catch { /* se usan los valores por defecto */ }
  try {
    vehiculos = (await conRespaldo('vehiculos', '/api/vehiculos')).datos;
    if (sesion.rol !== 'conductor') personas = await api('/api/personas');
  } catch { /* se reintenta al entrar a cada pantalla */ }

  vigilarPermisoUbicacion();      // que la franja se arregle sola al volver de los ajustes
  ir(vistaPedida() || MENU[sesion.rol][0]);
  cola.sincronizar();
  selloDatos = await leerSello();
  arrancarSincronizacion();

  if (sesion.debe_cambiar_clave) setTimeout(modalCambiarClave, 400);
}

/** Avisa si el Worker publicado es más viejo que lo que la aplicación espera. */
async function comprobarVersion() {
  let salud;
  try { salud = await (await fetch(API + '/api/salud')).json(); }
  catch { return; }                                   // sin red: no es el momento
  const v = Number(salud.version || 1);
  if (v >= VERSION_API_REQUERIDA) return;

  const barra = $('#barra-version');
  barra.innerHTML = `El servidor está desactualizado (versión ${v}; esta pantalla
    necesita la ${VERSION_API_REQUERIDA}). Algunos cambios no se guardarán.
    ${sesion.rol === 'principal'
      ? 'Vuelva a publicar el Worker en Cloudflare pegando <b>flota-worker-completo.js</b>.'
      : 'Avise a la Coordinación de Salud Pública.'}`;
  barra.classList.add('on');
}

// ── Sincronización entre usuarios ────────────────────────────────────────────
//
// Los datos son comunes: cualquiera que abra la pantalla ve lo último. Lo que
// no ocurría es que una pantalla YA abierta se enterara de un cambio hecho por
// otra persona. En vez de recargar todo cada minuto, se consulta un "sello" del
// estado de los datos —una consulta de cuatro conteos— y solo se redibuja
// cuando ese sello cambia.

let selloDatos = null;
let relojSincronizacion = null;
const CADA = 45000;             // ms entre consultas del sello

async function leerSello() {
  try { return (await api('/api/sello')).sello; } catch { return null; }
}

/** Redibuja la pantalla actual con datos frescos. */
async function refrescarVista() {
  if (!vistaActual || !VISTAS[vistaActual]) return;
  if (sesion.rol !== 'conductor') {
    try { [vehiculos, personas] = await Promise.all([api('/api/vehiculos'), api('/api/personas')]); }
    catch { /* se reintenta en el siguiente ciclo */ }
  }
  try { cat = await api('/api/catalogos'); } catch { /* idem */ }
  await VISTAS[vistaActual].fn();
}

/** Botón "Actualizar": siempre refresca, haya o no cambios. */
async function sincronizarAhora(silencioso) {
  const btn = $('#btn-sincronizar');
  if (btn) { btn.disabled = true; btn.textContent = 'Actualizando...'; }
  selloDatos = await leerSello();
  await refrescarVista();
  if (!silencioso) aviso('Pantalla actualizada', 'ok');
  const btn2 = $('#btn-sincronizar');
  if (btn2) { btn2.disabled = false; btn2.textContent = 'Actualizar'; }
}

/** Consulta periódica: solo redibuja si alguien cambió algo. */
async function revisarCambios() {
  if (!sesion || document.hidden) return;
  const sello = await leerSello();
  if (!sello || sello === selloDatos) return;
  selloDatos = sello;
  await refrescarVista();
  aviso('Alguien hizo cambios; la pantalla se actualizó', 'info', 'Sincronizado');
}

function arrancarSincronizacion() {
  clearInterval(relojSincronizacion);
  relojSincronizacion = setInterval(revisarCambios, CADA);
  // Volver a la pestaña o al celular es el momento en que más probable es que
  // la pantalla esté desactualizada.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) revisarCambios(); });
  window.addEventListener('focus', revisarCambios);
}

// ── Modal ────────────────────────────────────────────────────────────────────
function abrirModal(titulo, cuerpo, pie) {
  $('#modal-tit').textContent = titulo;
  $('#modal-cpo').innerHTML = cuerpo;
  $('#modal-pie').innerHTML = pie || '<button class="btn sec" onclick="cerrarModal()">Cerrar</button>';
  $('#modal').classList.add('on');
}
const cerrarModal = () => $('#modal').classList.remove('on');

function modalCambiarClave() {
  abrirModal('Cambie su clave', `
    <div class="nota avi" style="margin-bottom:1rem">
      Está usando una clave temporal. Defina una propia antes de continuar.
    </div>
    <div class="campo"><label class="lb">Clave actual <span class="req">*</span></label>
      <input class="inp" type="password" id="cc-actual"></div>
    <div class="campo"><label class="lb">Clave nueva <span class="req">*</span></label>
      <input class="inp" type="password" id="cc-nueva" placeholder="Mínimo 8 caracteres"></div>
    <div class="campo"><label class="lb">Repita la clave nueva <span class="req">*</span></label>
      <input class="inp" type="password" id="cc-rep"></div>
    <div id="cc-error" class="nota avi" style="display:none"></div>`,
    `<button class="btn" onclick="guardarClave()">Guardar</button>`);
}

async function guardarClave() {
  const a = $('#cc-actual').value, n = $('#cc-nueva').value, r = $('#cc-rep').value;
  const err = $('#cc-error');
  const mostrar = m => { err.textContent = m; err.style.display = 'block'; };
  if (n.length < 8) return mostrar('La clave nueva debe tener al menos 8 caracteres.');
  if (n !== r)      return mostrar('Las dos claves nuevas no coinciden.');
  try {
    await api('/api/auth/cambiar-clave', { metodo: 'POST', cuerpo: { clave_actual: a, clave_nueva: n } });
    sesion.debe_cambiar_clave = false;
    localStorage.setItem('flota_sesion', JSON.stringify(sesion));
    cerrarModal();
    aviso('Su clave quedó actualizada', 'ok', 'Listo');
  } catch (e) { mostrar(e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// MI DÍA — pantalla del conductor
// ═══════════════════════════════════════════════════════════════════════════

let diaActual = null;

/**
 * Mezcla las marcas de la cola sobre el día bajado del servidor.
 *
 * Sin esto, el conductor sin señal toca "Registrar salida", la marca se guarda
 * en el teléfono... y la pantalla sigue igual, ofreciéndole registrar la salida
 * otra vez. Volvería a tocarla, y quedarían dos salidas del mismo viaje.
 *
 * Lo que se pinta desde la cola se marca con `pendiente: true`, para que la
 * pantalla lo distinga de lo que ya está en el servidor y no se le prometa al
 * conductor algo que todavía no ha salido del teléfono.
 */
async function superponerCola(dia) {
  const marcas = (await cola.leer())
    .filter(m => m.fecha_operacion === hoy())
    .sort((a, b) => String(a.ts_dispositivo).localeCompare(String(b.ts_dispositivo)));
  if (!marcas.length) return dia;

  const d = { ...dia, trayectos: [...(dia.trayectos || [])] };
  for (const m of marcas) {
    if (m.hito === 'salida') {
      const suelto = {
        id: m.local_id, consecutivo: 'Sin enviar', pendiente: true,
        estado: 'en_curso', ts_salida: m.ts_dispositivo,
        lugar_salida: m.lugar, km_inicial: m.km_inicial,
        vehiculo_id: m.vehiculo_id,
      };
      d.trayectos.unshift(suelto);
      d.trayecto_abierto = suelto;
    } else {
      // La llegada cierra el viaje al que apunta, esté en el servidor o en la cola.
      const t = d.trayectos.find(x => String(x.id) === String(m.trayecto_id));
      if (t) {
        Object.assign(t, {
          estado: 'cerrado', pendiente: true,
          ts_llegada: m.ts_dispositivo, lugar_llegada: m.lugar, km_final: m.km_final,
        });
      }
      if (String(d.trayecto_abierto?.id) === String(m.trayecto_id)) d.trayecto_abierto = null;
    }
  }
  return d;
}

// ── Itinerario del conductor ─────────────────────────────────────────────────
//
// No es la matriz de Coordinación, que trae todos los vehículos y sirve para
// editar. Aquí el conductor ve SOLO lo suyo y solo lo lee: qué le toca los
// próximos días, con qué vehículo y para dónde. El filtro por conductor lo hace
// el servidor, no esta pantalla.

let itinDiasConductor = Number(localStorage.getItem('flota_mi_itin_dias')) || 15;

async function verMiItinerario() {
  $('#main').innerHTML = '<div class="cargando">Cargando su itinerario...</div>';
  let datos, deCaja = false;
  try {
    ({ datos, deCaja } = await conRespaldo(
      `mi-itinerario:${hoy()}:${itinDiasConductor}`,
      `/api/mi-itinerario?desde=${hoy()}&dias=${itinDiasConductor}`));
  } catch (e) {
    return $('#main').innerHTML = `<div class="card"><div class="nota avi">
      ${esFalloDeRed(e)
        ? 'Sin señal y todavía no se ha guardado su itinerario en este teléfono. Ábralo una vez con señal.'
        : esc(e.message)}</div></div>`;
  }

  const porFecha = new Map((datos.dias || []).map(d => [d.fecha, d]));

  // Se listan TODOS los días del período, con programación o sin ella: un día en
  // blanco es información —"ese día no me toca"— y si solo se pintaran los días
  // programados el conductor no sabría si es que no le toca o si falta cargarlo.
  const filas = [];
  for (let i = 0; i < itinDiasConductor; i++) {
    const f = nDias(hoy(), i);
    filas.push({ fecha: f, it: porFecha.get(f) || null, esHoy: i === 0 });
  }

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Mi itinerario</h1>
        <p>Su programación de los próximos días. Solo de consulta: los cambios
           los hace la Coordinación de Salud Pública.</p></div>
      <button class="btn sec sm" onclick="verMiItinerario()">Actualizar</button>
    </div>

    ${deCaja ? `<div class="nota avi" style="margin-bottom:.8rem">
      Sin señal: esto es lo último que se guardó en el teléfono. Puede que la
      Coordinación lo haya cambiado desde entonces.</div>` : ''}

    ${datos.sin_persona ? `
      <div class="card" style="border-left:4px solid var(--rojo)">
        <b>Su cuenta no está vinculada a una persona</b>
        <p style="margin:.4rem 0 0;font-size:.88rem;color:var(--text-soft)">
          Por eso no ve su programación. Avise a la Coordinación de Salud Pública.</p>
      </div>` : ''}

    <div class="chips" style="margin-bottom:.9rem">
      ${[7, 15, 30].map(n => `<button class="chip ${n === itinDiasConductor ? 'on' : ''}"
        onclick="cambiarDiasMiItinerario(${n})">${n} días</button>`).join('')}
    </div>

    ${filas.map(({ fecha, it, esHoy }) => {
      const tj = it ? (TIPOS_JORNADA[it.tipo_jornada] || TIPOS_JORNADA.ebs) : null;
      return `
      <div class="card dia-itin ${esHoy ? 'es-hoy' : ''} ${it ? '' : 'libre'}">
        <div class="dia-fecha">
          <div class="dia-nombre">${diaSemana(fecha)}${esHoy ? ' · HOY' : ''}</div>
          <div class="dia-num">${new Date(fecha + 'T12:00:00')
            .toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })
            .replace(' de ', ' ').replace('.', '')}</div>
        </div>
        <div class="dia-cuerpo">
          ${it ? `
            <div class="dia-destino">${esc(it.destino || 'Sin destino asignado')}</div>
            <div class="dia-sub">${esc(it.municipio || '')}${it.placa ? ' · ' : ''}
              ${it.placa ? `<span class="placa">${esc(it.placa)}</span>` : ''}</div>
            ${it.observaciones ? `<div class="dia-obs">${esc(it.observaciones)}</div>` : ''}`
          : '<div class="dia-libre">Sin programación</div>'}
        </div>
        <div class="dia-etq">
          ${tj ? `<span class="etq ${tj.color}">${tj.et}</span>` : ''}
          ${it && it.viajes > 0 ? `<span class="etq verde">${it.viajes} viaje(s)</span>` : ''}
        </div>
      </div>`;
    }).join('')}
  `;
}

function cambiarDiasMiItinerario(n) {
  itinDiasConductor = n;
  localStorage.setItem('flota_mi_itin_dias', String(n));
  verMiItinerario();
}

async function verHoy() {
  $('#main').innerHTML = '<div class="cargando">Cargando su día...</div>';
  let deCaja = false;
  try {
    // Con señal se baja y se guarda; sin señal se trabaja con la última copia.
    // La clave lleva la fecha: la copia de ayer no debe hacerse pasar por hoy.
    ({ datos: diaActual, deCaja } =
      await conRespaldo('mi-dia:' + hoy(), '/api/mi-dia?fecha=' + hoy()));
  } catch (e) {
    return $('#main').innerHTML = `<div class="card"><div class="nota avi">
      ${esFalloDeRed(e)
        ? `Sin señal y todavía no se ha guardado el día de hoy en este teléfono.
           Ábralo una vez con señal y de ahí en adelante funciona sin ella.`
        : esc(e.message)}</div></div>`;
  }

  // Las marcas que están en la cola aún no existen en el servidor. Se superponen
  // sobre la copia para que el conductor VEA lo que acaba de registrar: sin esto
  // tocaría "Registrar salida", no pasaría nada visible y volvería a tocarlo.
  diaActual = await superponerCola(diaActual);

  const { itinerario: it, trayecto_abierto: abierto, trayectos } = diaActual;
  const f = hoy();

  const tj = it ? (TIPOS_JORNADA[it.tipo_jornada] || TIPOS_JORNADA.ebs) : null;

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>${diaSemana(f)}</h1>
        <p>${new Date(f + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
      <button class="btn sec sm" onclick="sincronizarAhora()" id="btn-sincronizar">Actualizar</button>
    </div>

    <div id="gps-hoy">${avisoUbicacion('hoy')}</div>

    ${diaActual.fuera_servicio ? `
      <div class="card" style="border-left:4px solid var(--rojo);margin-bottom:.85rem">
        <b>Este vehículo está registrado fuera de servicio</b>
        <p style="margin:.4rem 0 0;font-size:.88rem;color:var(--text-soft)">
          ${esc(causaEt(diaActual.fuera_servicio.causa))}, desde el
          ${esc(diaActual.fuera_servicio.fecha_inicio)}${diaActual.fuera_servicio.fecha_fin
            ? ' hasta el ' + esc(diaActual.fuera_servicio.fecha_fin) : ', sin fecha de regreso'}.
          No hace falta que lo vuelva a reportar. Si ya está arreglado, avise a
          Coordinación para que cierre el registro.</p>
      </div>` : ''}

    ${diaActual.sin_persona ? `
      <div class="card" style="border-left:4px solid var(--rojo)">
        <b>Su cuenta no está vinculada a una persona</b>
        <p style="margin:.4rem 0 0;font-size:.88rem;color:var(--text-soft)">
          Por eso no ve su programación: el itinerario se asigna a la persona, no a la
          cuenta. Avise a la Coordinación de Salud Pública para que la vincule desde
          la pantalla de Usuarios.</p>
      </div>` : ''}

    ${it ? `
      <div class="card" style="border-left:4px solid var(--azul)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
          <div>
            <div style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Programación de hoy</div>
            <div style="font-size:1.25rem;font-weight:800;margin-top:.2rem">${esc(it.destino || 'Sin destino asignado')}</div>
            <div style="color:var(--text-soft);font-size:.85rem;margin-top:.1rem">
              ${esc(it.municipio || '')} · Vehículo <span class="placa">${esc(it.placa)}</span>
            </div>
          </div>
          <span class="etq ${tj.color}">${tj.et}</span>
        </div>
        ${it.observaciones ? `<div class="nota" style="margin-top:.75rem">${esc(it.observaciones)}</div>` : ''}
      </div>` : `
      <div class="card">
        <div class="nota avi">Hoy no tiene programación asignada. Si va a salir de todos modos,
        avise a Coordinación para que quede registrada.</div>
      </div>`}

    <div class="card" style="margin-top:.85rem">
      ${abierto ? `
        <div class="nota" style="margin-bottom:.85rem">
          <b>Viaje en curso</b><br>
          Salió de ${esc(abierto.lugar_salida || 'la base')} a las ${hora(abierto.ts_salida)}
          · ${esc(abierto.consecutivo)}
        </div>
        <button class="btn-gigante llegada" onclick="marcar('llegada')">
          REGISTRAR LLEGADA
          <small>Toque al llegar a su destino</small>
        </button>` : `
        <button class="btn-gigante salida" onclick="marcar('salida')" ${!it && !diaActual.permitirSinItinerario ? '' : ''}>
          REGISTRAR SALIDA
          <small>Toque al arrancar</small>
        </button>`}
      <p style="text-align:center;font-size:.72rem;color:var(--muted);margin:.85rem 0 0">
        Se registra la hora del servidor y su ubicación en ese momento.
        No hay seguimiento en segundo plano.
      </p>
    </div>

    <div class="grid g2" style="margin-top:.85rem">
      <button class="btn sec" style="padding:.85rem" onclick="modalChecklist()">
        Diligenciar checklist
      </button>
      <button class="btn ambar" style="padding:.85rem" onclick="modalEvento()">
        Reportar novedad
      </button>
    </div>

    ${diaActual.vehiculo_id && !diaActual.fuera_servicio ? `
      <button class="btn sec" style="width:100%;margin-top:.5rem;padding:.75rem"
        onclick="modalAveriaConductor()">
        El vehículo quedó averiado
      </button>` : ''}

    <h2 style="margin:1.4rem 0 .6rem">Viajes de hoy</h2>
    ${trayectos.length ? trayectos.map(t => `
      <div class="card" style="padding:.75rem .85rem;margin-bottom:.5rem">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem">
          <b style="font-size:.8rem;color:var(--muted)">${esc(t.consecutivo || '')}</b>
          ${t.pendiente
            ? '<span class="etq ambar">Guardado en el celular</span>'
            : t.estado === 'cerrado'
              ? '<span class="etq verde">Cerrado</span>'
              : '<span class="etq ambar">En curso</span>'}
        </div>
        <div style="display:flex;align-items:center;gap:.6rem;margin-top:.5rem">
          <div style="flex:1">
            <div style="font-size:.68rem;color:var(--muted);font-weight:700">SALIÓ</div>
            <div style="font-weight:700">${hora(t.ts_salida)}</div>
            <div style="font-size:.78rem;color:var(--text-soft)">${esc(t.lugar_salida || '—')}</div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          <div style="flex:1">
            <div style="font-size:.68rem;color:var(--muted);font-weight:700">LLEGÓ</div>
            <div style="font-weight:700">${hora(t.ts_llegada)}</div>
            <div style="font-size:.78rem;color:var(--text-soft)">${esc(t.lugar_llegada || '—')}</div>
          </div>
        </div>
      </div>`).join('')
      : '<div class="card"><div class="vacio">Todavía no ha registrado viajes hoy.</div></div>'}
  `;

  // El estado del permiso se consulta aparte, porque es asíncrono: la pantalla
  // se pinta ya y la franja se corrige sola un instante después.
  leerPermisoUbicacion().then(pintarPermisoUbicacion);
}

/** Marca salida o llegada. Si no hay señal, guarda en el celular y sigue. */
async function marcar(hito) {
  const it = diaActual?.itinerario;
  const abierto = diaActual?.trayecto_abierto;
  fotoTomada = null;

  const municipios = cat.municipios.map(m =>
    `<option value="${m.id}" ${it && it.municipio_id == m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('');
  const lugarSugerido = hito === 'salida'
    ? (it ? '' : '') : (it?.destino || '');

  // Sin programación no hay vehículo que deducir. En vez de fallar con un
  // mensaje técnico, se le pide que lo escoja: un viaje no programado también
  // debe poder registrarse, y el dashboard lo marca como ejecutado sin programar.
  const suyo = vehiculos.find(v => v.conductor_id === sesion.persona_id);
  const pedirVehiculo = hito === 'salida' && !it;

  abrirModal(hito === 'salida' ? 'Registrar salida' : 'Registrar llegada', `
    ${pedirVehiculo ? `
      <div class="nota avi" style="margin-bottom:1rem">
        Hoy no tiene programación. Puede registrar la salida igual; quedará marcada
        como viaje no programado.</div>
      <div class="campo"><label class="lb">Vehículo <span class="req">*</span></label>
        <select class="inp" id="mk-veh">
          <option value="">— Escoja el vehículo —</option>
          ${vehiculos.filter(v => v.activo !== 0).map(v =>
            `<option value="${v.id}" ${suyo && suyo.id === v.id ? 'selected' : ''}>${esc(v.placa)}${
              suyo && suyo.id === v.id ? ' (el suyo)' : ''}</option>`).join('')}
        </select></div>` : ''}
    <div class="campo"><label class="lb">Municipio <span class="req">*</span></label>
      <select class="inp" id="mk-mun"><option value="">— Seleccione —</option>${municipios}</select></div>
    <div class="campo"><label class="lb">Lugar <span class="req">*</span></label>
      <input class="inp" id="mk-lugar" value="${esc(lugarSugerido)}"
        placeholder="${hito === 'salida' ? 'Ej: Base Ábrego' : 'Ej: Santa Inés'}"></div>
    <div class="campo">
      <label class="lb">Kilometraje ${hito === 'salida' ? 'inicial' : 'final'} <span class="req">*</span></label>
      <input class="inp" id="mk-km" type="number" inputmode="numeric"
        ${hito === 'llegada' && abierto?.km_inicial ? `min="${abierto.km_inicial}"` : ''}
        placeholder="Lea el odómetro">
      ${hito === 'llegada' && abierto?.km_inicial
        ? `<p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0">
             Al salir marcó ${num(abierto.km_inicial)} km</p>` : ''}
    </div>
    ${hito === 'salida' ? `
      <div class="campo">
        <label class="lb">Personas a bordo <span class="req">*</span></label>
        <input class="inp" id="mk-trip" type="number" inputmode="numeric" min="1"
          value="${it?.num_tripulantes || ''}" placeholder="Cuántas van, contándose usted"></div>
      <div class="campo">
        <label class="lb">Nombres de los tripulantes <span class="req">*</span></label>
        <textarea class="inp" id="mk-tripulantes" rows="2"
          placeholder="Sepárelos con coma. Ej: Juan Pérez, Ana Gómez"></textarea>
        <p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0">
          Queda en el soporte: es la constancia de quién iba a bordo.</p></div>` : ''}

    ${bloqueFoto(hito)}

    <div class="campo"><label class="lb">Observaciones</label>
      <textarea class="inp" id="mk-obs" rows="2" placeholder="Opcional"></textarea></div>
    <div id="mk-gps">${avisoUbicacion('marca')}</div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn ${hito === 'salida' ? 'verde' : ''}" id="mk-btn"
       onclick="guardarMarca('${hito}')">Guardar</button>`);

  leerPermisoUbicacion().then(pintarPermisoUbicacion);
}

// ── Permiso de ubicación ─────────────────────────────────────────────────────
//
// Varios conductores tocaron "Bloquear" por error y después no encontraban cómo
// devolverse. Conviene tener claro el límite, porque manda sobre todo lo demás:
//
//   Una página web NO PUEDE volver a mostrar el cuadro del permiso una vez el
//   conductor tocó "Bloquear". El navegador recuerda esa decisión para el sitio
//   y las llamadas siguientes fallan de inmediato, sin preguntar nada. Solo se
//   deshace desde los ajustes del teléfono o del navegador.
//
// Lo que sí se puede, y es lo que hace este módulo:
//
//   · Si el conductor solo ESQUIVÓ el cuadro —lo deslizó sin contestar—, el
//     permiso sigue en "prompt" y volver a pedirlo SÍ lo muestra otra vez. Ese
//     es el caso que el botón arregla de un toque, y es el más común.
//   · Si está BLOQUEADO, se le explica, con los pasos de su teléfono, dónde
//     tocar. No se le deja adivinando.
//   · Se queda escuchando el permiso: cuando lo arregla en los ajustes y vuelve
//     a la aplicación, la franja se pone verde sola, sin que tenga que hacer nada.
//
// Y pase lo que pase, la marca se guarda igual, señalada sin GPS: un conductor
// en la vía no se puede quedar sin registrar por un permiso.

let permisoUbicacion = null;        // 'granted' | 'prompt' | 'denied' | null

/** Estado del permiso. Devuelve null si el navegador no sabe decirlo. */
async function leerPermisoUbicacion() {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    permisoUbicacion = p?.state ?? null;
    return permisoUbicacion;
  } catch {
    return (permisoUbicacion = null);   // Safari viejo: no sabe. Se asume que hay que pedirlo.
  }
}

/**
 * Deja la aplicación pendiente del permiso.
 *
 * Es la parte que evita el peor momento: el conductor sale de la aplicación, lo
 * arregla en los ajustes del teléfono y vuelve. Sin esto vería la franja roja
 * igual y creería que no sirvió.
 */
async function vigilarPermisoUbicacion() {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (!p) return;
    permisoUbicacion = p.state;
    p.addEventListener('change', () => refrescarPermiso(p.state));
  } catch { /* si el navegador no lo soporta, se sigue sin vigilancia */ }
}

function refrescarPermiso(nuevo) {
  const cambio = nuevo !== permisoUbicacion;
  permisoUbicacion = nuevo;
  pintarPermisoUbicacion();
  if (cambio && nuevo === 'granted') {
    aviso('Ya puede registrar con ubicación', 'ok', 'Ubicación activada');
  }
}

// Volver a mirar el permiso cada vez que la aplicación vuelve al frente.
//
// Es EL momento que importa: el conductor sale a los ajustes del teléfono, lo
// permite y regresa. El evento "change" del permiso no siempre llega —depende
// del navegador—, pero volver a la aplicación siempre ocurre. Sin esto vería la
// franja roja igual y creería que no sirvió de nada.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !sesion) return;
  leerPermisoUbicacion().then(refrescarPermiso);
});

/**
 * Franja de aviso.
 *
 * @param donde 'marca' en el pie del formulario, donde se espera la nota; 'hoy'
 *              en la pantalla del día, donde si todo está bien no se dice nada:
 *              el conductor no necesita un recordatorio diario de algo que ya
 *              está resuelto.
 */
function avisoUbicacion(donde) {
  if (permisoUbicacion === 'granted') {
    if (donde === 'hoy') return '';
    return `<div class="nota" style="background:var(--verde-glow);border-color:rgba(10,125,87,.25);color:#065c40">
      Ubicación permitida. Al guardar se toma su posición de ese momento.</div>`;
  }
  if (permisoUbicacion === 'denied') {
    return `<div class="nota avi" style="background:var(--rojo-glow);border-color:rgba(194,46,36,.28);color:#8c1f18">
      <b>La ubicación está bloqueada en este teléfono.</b>
      <p style="margin:.35rem 0 .6rem">Sus marcas quedarán sin GPS hasta que la active.</p>
      <button type="button" class="btn bloque" onclick="activarUbicacion()"
        style="background:var(--rojo)">Activar la ubicación</button></div>`;
  }
  return `<div class="nota">${donde === 'hoy'
      ? 'Todavía no ha permitido la ubicación. Mejor actívela ahora, en la base, y no en la vía.'
      : 'Al guardar se solicitará su ubicación.'}
    <button type="button" class="btn sec bloque" onclick="activarUbicacion()"
      style="margin-top:.5rem">Permitir ubicación ahora</button></div>`;
}

/** Repinta todos los sitios donde se enseña el estado del permiso. */
function pintarPermisoUbicacion() {
  for (const [id, donde] of [['#gps-hoy', 'hoy'], ['#mk-gps', 'marca']]) {
    const n = $(id);
    if (n && !n.dataset.ocupado) n.innerHTML = avisoUbicacion(donde);
  }
}

/**
 * El botón. Si el permiso sigue en "prompt" vuelve a pedirlo de verdad —el
 * navegador muestra el cuadro otra vez— y si está bloqueado explica los pasos,
 * que es lo único que queda.
 */
async function activarUbicacion() {
  const estado = await leerPermisoUbicacion();
  if (estado === 'denied') return modalPermisoUbicacion();

  aviso('Toque "Permitir" en el cuadro que aparece', 'avi', 'Pidiendo la ubicación');
  const geo = await ubicacion();
  await leerPermisoUbicacion();
  pintarPermisoUbicacion();

  if (geo.lat) {
    aviso(`Ubicación tomada (precisión ${Math.round(geo.precision)} m)`, 'ok', 'Listo');
  } else if (permisoUbicacion === 'denied') {
    modalPermisoUbicacion();          // contestó que no en ese mismo momento
  } else {
    aviso('No se pudo obtener la ubicación. Salga a cielo abierto e intente de nuevo',
          'avi', 'Sin señal de GPS');
  }
}

/** Instructivo por sistema: es lo único que queda cuando ya está bloqueado. */
function modalPermisoUbicacion() {
  const instalada = estaInstalada();
  let pasos;
  if (esIOS()) {
    pasos = `<ol class="pasos">
        <li>Salga a los <b>Ajustes</b> del iPhone.</li>
        <li>Entre a <b>Privacidad y seguridad</b> → <b>Localización</b>.</li>
        <li>Confirme que <b>Localización</b> esté encendida.</li>
        <li>Busque <b>${instalada ? 'Flota HRNO' : 'Safari'}</b> en la lista y elija
            <b>Preguntar la próxima vez</b> o <b>Al usar la app</b>.</li>
        <li>Vuelva a Flota y toque de nuevo el botón.</li>
      </ol>`;
  } else if (instalada) {
    pasos = `<ol class="pasos">
        <li>Salga a los <b>Ajustes</b> del teléfono.</li>
        <li>Entre a <b>Aplicaciones</b> y busque <b>Flota HRNO</b>.</li>
        <li>Toque <b>Permisos</b> → <b>Ubicación</b>.</li>
        <li>Elija <b>Permitir solo mientras se usa la aplicación</b>.</li>
        <li>Vuelva a Flota. La franja se pone verde sola.</li>
      </ol>`;
  } else {
    pasos = `<ol class="pasos">
        <li>En Chrome, toque el icono que está a la <b>izquierda de la dirección</b>
            (un candado o unos controles).</li>
        <li>Toque <b>Permisos</b> o <b>Configuración del sitio</b>.</li>
        <li>Busque <b>Ubicación</b> y cámbielo a <b>Permitir</b>.</li>
        <li>Vuelva a esta pantalla y toque de nuevo el botón.</li>
      </ol>`;
  }

  abrirModal('Activar la ubicación',
    `<p class="nota avi">Usted tocó <b>Bloquear</b> cuando le pidieron la ubicación.
      Desde aquí no se puede volver a preguntar: el teléfono ya guardó esa
      respuesta y hay que cambiarla en los ajustes. Son cuatro toques.</p>
     ${pasos}
     <p class="nota" style="margin-top:.7rem">Mientras tanto puede seguir
      registrando sus salidas y llegadas: quedan marcadas <b>sin GPS</b>.</p>`,
    `<button class="btn sec" onclick="cerrarModal()">Cerrar</button>
     <button class="btn" onclick="reintentarUbicacion()">Ya lo permití</button>`);
}

/** Tras arreglarlo en los ajustes, comprobar sin tener que salir y entrar. */
async function reintentarUbicacion() {
  const estado = await leerPermisoUbicacion();
  pintarPermisoUbicacion();
  if (estado === 'denied') {
    return aviso('Todavía figura bloqueada. Revise los pasos de arriba', 'mal', 'Sigue bloqueada');
  }
  cerrarModal();
  activarUbicacion();
}

let fotoTomada = null;         // { mime, datos } de la marca en curso

// ── Fotografía con aplicación externa ────────────────────────────────────────
//
// Coordinación pidió que la foto se tome con Timemark, que estampa fecha, hora
// y coordenadas sobre la imagen. Hay dos límites del navegador que conviene
// tener presentes, porque determinan el flujo:
//
//   1. Una página web NO PUEDE saber si una aplicación está instalada. Lo que
//      sí existe en Android es la URL "intent", que abre la aplicación si está
//      y, si no, lleva a la dirección de respaldo — la ficha de Play Store.
//      Es exactamente el comportamiento pedido, y lo resuelve el propio Chrome.
//   2. Una página web NO PUEDE recibir la foto de vuelta de otra aplicación.
//      Timemark la guarda en la galería, así que el conductor vuelve y la
//      adjunta desde ahí. Por eso son dos pasos y no uno.

const esAndroid = () => /Android/i.test(navigator.userAgent);
const esIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * ¿Se está usando desde un teléfono?
 *
 * No basta con mirar el "user agent". Si el conductor tiene marcada la opción
 * «Sitio de escritorio» en Chrome —o su teléfono la trae puesta—, el navegador
 * miente y dice ser un computador: desaparece la palabra Android del user agent.
 * Pasó en un teléfono de verdad y la marca de salida mostró el texto de
 * computador en vez de los dos pasos de Timemark.
 *
 * Lo que no se puede falsear igual de fácil es la pantalla táctil: un dedo es un
 * puntero "grueso" (pointer: coarse). Con eso alcanza para decidir si se ofrece
 * el flujo del teléfono.
 */
const esMovil = () => esAndroid() || esIOS() ||
  window.matchMedia?.('(pointer: coarse)').matches === true;

function bloqueFoto(hito) {
  const usaApp = par('app_foto_activa', '1') === '1';
  const nombre = par('app_foto_nombre', 'Timemark');

  if (!usaApp) {
    return `<div class="campo">
      <label class="lb">Fotografía de ${hito} <span class="req">*</span></label>
      <input type="file" id="mk-foto" accept="image/*" capture="environment"
        style="display:none" onchange="tomarFoto(this)">
      <button type="button" class="btn sec bloque" id="mk-foto-btn"
        onclick="$('#mk-foto').click()" style="padding:.8rem">Tomar fotografía</button>
      ${vistaFoto()}
    </div>`;
  }

  const movil = esMovil();
  return `<div class="campo">
    <label class="lb">Fotografía de ${hito} <span class="req">*</span></label>
    ${movil ? `
      <button type="button" class="btn bloque" onclick="abrirAppFoto()"
        style="padding:.8rem;margin-bottom:.5rem">
        1 · Abrir ${esc(nombre)}</button>
      <p style="font-size:.74rem;color:var(--muted);margin:0 0 .6rem">
        Tome la foto en ${esc(nombre)} —queda con fecha, hora y ubicación estampadas—
        vuelva aquí y adjúntela.</p>` : `
      <div class="nota" style="margin-bottom:.6rem">
        ${esc(nombre)} es una aplicación de celular. Desde el computador, adjunte
        la fotografía que el conductor ya tomó.</div>`}
    <input type="file" id="mk-foto" accept="image/*" style="display:none"
      onchange="tomarFoto(this)">
    <button type="button" class="btn sec bloque" id="mk-foto-btn"
      onclick="$('#mk-foto').click()" style="padding:.8rem">
      ${movil ? `2 · Adjuntar la foto de ${esc(nombre)}` : 'Adjuntar fotografía'}</button>
    ${vistaFoto()}
  </div>`;
}

const vistaFoto = () => `
  <div id="mk-foto-vista" style="display:none;margin-top:.5rem">
    <img id="mk-foto-img" style="width:100%;border-radius:var(--r);border:1px solid var(--border)">
    <p style="font-size:.72rem;color:var(--muted);margin:.3rem 0 0" id="mk-foto-peso"></p>
    <div id="mk-foto-avi"></div>
  </div>`;

/**
 * Abre la aplicación de fotos y, si no está instalada, lleva a la tienda.
 *
 * En Android lo resuelve la URL "intent" con dirección de respaldo. En iOS no
 * existe ese mecanismo, así que se abre la ficha de la App Store: si la
 * aplicación ya está, el botón de esa ficha dice "Abrir".
 */
function urlAppFoto() {
  // Si no dice ser iPhone se trata como Android: es lo que usa la flota, y si el
  // user agent viene falseado por «Sitio de escritorio» esta es la salida útil.
  if (esIOS()) {
    return `https://apps.apple.com/app/id${par('app_foto_ios', '6446071834')}`;
  }
  if (esMovil()) {
    const paquete = par('app_foto_android', 'com.oceangalaxy.camera.new');
    const tienda = `https://play.google.com/store/apps/details?id=${paquete}`;
    // El respaldo lo aplica el propio Chrome cuando el paquete no está instalado.
    return 'intent:#Intent;action=android.intent.action.MAIN' +
      ';category=android.intent.category.LAUNCHER' +
      `;package=${paquete}` +
      `;S.browser_fallback_url=${encodeURIComponent(tienda)};end`;
  }
  return null;                       // en computador no hay a dónde ir
}

function abrirAppFoto() {
  const destino = urlAppFoto();
  if (!destino) {
    return aviso(`${par('app_foto_nombre', 'Timemark')} es una aplicación de celular; ` +
                 'desde el computador adjunte la foto directamente', 'avi', 'Solo en celular');
  }
  location.href = destino;
}

/**
 * Reduce la foto a 1280 px de ancho y la comprime antes de subirla.
 *
 * Una foto de celular pesa varios megabytes; así queda en unos 100 KB. Se hace
 * en el teléfono porque en el Catatumbo la subida es el cuello de botella, y
 * porque la base guarda estas imágenes y crecería sin control.
 */
function tomarFoto(input, pref = 'mk') {
  const archivo = input.files?.[0];
  input.value = '';
  if (!archivo) return;

  const lector = new FileReader();
  lector.onload = () => {
    const img = new Image();
    img.onerror = () => aviso('No se pudo leer la imagen', 'mal');
    img.onload = () => {
      const ANCHO = 1280;
      const escala = Math.min(1, ANCHO / img.width);
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.width * escala);
      lienzo.height = Math.round(img.height * escala);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);

      let url = lienzo.toDataURL('image/jpeg', 0.72);
      // Si aún pesa mucho (fotos muy detalladas), se aprieta otra vez
      if (url.length * 3 / 4 > 550_000) url = lienzo.toDataURL('image/jpeg', 0.55);

      fotoTomada = { mime: 'image/jpeg', datos: url.slice(url.indexOf(',') + 1) };
      $(`#${pref}-foto-img`).src = url;
      $(`#${pref}-foto-vista`).style.display = '';
      $(`#${pref}-foto-peso`).textContent =
        `${Math.round(fotoTomada.datos.length * 3 / 4 / 1024)} KB · toque el botón para cambiarla`;
      $(`#${pref}-foto-btn`).textContent = 'Cambiar fotografía';

      // Al adjuntar desde la galería se podría escoger una foto de otro día.
      // No se bloquea —puede haber una razón válida— pero se dice.
      const tope = Number(par('foto_antiguedad_minutos', '60'));
      const minutos = archivo.lastModified
        ? Math.round((Date.now() - archivo.lastModified) / 60000) : 0;
      const avi = $(`#${pref}-foto-avi`);
      if (avi) avi.innerHTML = tope && minutos > tope
        ? `<div class="nota avi" style="margin-top:.4rem">Esta foto se tomó hace
             ${minutos >= 1440 ? Math.round(minutos / 1440) + ' día(s)' : minutos + ' minutos'}.
             Verifique que sea la de este viaje.</div>`
        : '';
    };
    img.src = lector.result;
  };
  lector.readAsDataURL(archivo);
}

async function guardarMarca(hito) {
  const btn = $('#mk-btn');
  const mun = $('#mk-mun').value, lugar = $('#mk-lugar').value.trim();
  if (!mun || !lugar) return aviso('Indique el municipio y el lugar', 'mal', 'Faltan datos');

  const km = $('#mk-km').value;
  if (!km) return aviso(`Lea el odómetro y escriba el kilometraje ${hito === 'salida' ? 'inicial' : 'final'}`,
                        'mal', 'Falta el kilometraje');
  if (hito === 'salida') {
    if (!$('#mk-trip').value) return aviso('Indique cuántas personas van a bordo', 'mal', 'Falta la tripulación');
    if (!$('#mk-tripulantes').value.trim()) {
      return aviso('Escriba los nombres de los tripulantes', 'mal', 'Falta la tripulación');
    }
  } else if (diaActual?.trayecto_abierto?.km_inicial &&
             Number(km) < Number(diaActual.trayecto_abierto.km_inicial)) {
    return aviso(`El kilometraje no puede ser menor que ${num(diaActual.trayecto_abierto.km_inicial)}`,
                 'mal', 'Kilometraje incoherente');
  }
  if (!fotoTomada) return aviso(`Tome la fotografía de ${hito}`, 'mal', 'Falta la fotografía');
  const vehSelect = $('#mk-veh');
  if (vehSelect && !vehSelect.value) {
    return aviso('Escoja el vehículo con el que sale', 'mal', 'Falta el vehículo');
  }

  btn.disabled = true; btn.textContent = 'Ubicando...';
  const nota = $('#mk-gps');
  nota.dataset.ocupado = '1';        // que un repintado no borre el progreso
  nota.innerHTML = '<div class="nota">Obteniendo su ubicación...</div>';
  const geo = await ubicacion();
  await leerPermisoUbicacion();
  nota.innerHTML = geo.lat
    ? `<div class="nota">Ubicación tomada (precisión ${Math.round(geo.precision)} m)</div>`
    : `<div class="nota avi">No se pudo obtener la ubicación. La marca se registra
         igual, señalada sin GPS.</div>${permisoUbicacion === 'denied' ? avisoUbicacion('marca') : ''}`;
  delete nota.dataset.ocupado;

  const datos = {
    municipio_id: Number(mun), lugar, ...geo,
    observaciones: $('#mk-obs').value.trim() || undefined,
    ts_dispositivo: new Date().toISOString(),
    foto: fotoTomada,
  };
  if (hito === 'salida') {
    datos.km_inicial = Number(km);
    datos.num_tripulantes = Number($('#mk-trip').value);
    datos.tripulantes = $('#mk-tripulantes').value.trim();
    datos.vehiculo_id = diaActual?.itinerario?.vehiculo_id
      || ($('#mk-veh')?.value ? Number($('#mk-veh').value) : undefined);
  } else {
    datos.km_final = Number(km);
  }

  btn.textContent = 'Guardando...';
  try {
    if (hito === 'salida') await api('/api/trayectos/salida', { metodo: 'POST', cuerpo: datos });
    else await api(`/api/trayectos/${diaActual.trayecto_abierto.id}/llegada`, { metodo: 'POST', cuerpo: datos });
    cerrarModal();
    aviso(hito === 'salida' ? 'Salida registrada' : 'Llegada registrada', 'ok', 'Listo');
    verHoy();
  } catch (e) {
    // Sin señal: se guarda en el celular, CON su fotografía, y se envía cuando
    // vuelva la cobertura. Antes la foto se descartaba porque la cola vivía en
    // localStorage y no cabía; ahora vive en IndexedDB, donde sí hay sitio.
    if (esFalloDeRed(e)) {
      try {
        await cola.agregar({
          hito, ...datos,
          fecha_operacion: hoy(),
          trayecto_id: hito === 'llegada' ? diaActual.trayecto_abierto.id : undefined,
        });
      } catch {
        // Si ni así se pudo guardar, hay que decirlo: callarlo sería perder la
        // marca sin que el conductor se entere.
        btn.disabled = false; btn.textContent = 'Guardar';
        return aviso('No se pudo guardar en el teléfono. Libere espacio e intente de nuevo',
                     'mal', 'Sin espacio');
      }
      cerrarModal();
      aviso('Sin señal: la marca y la fotografía quedaron guardadas en el celular y se enviarán solas.',
            'avi', 'Guardado en el celular');
      verHoy();
    } else {
      aviso(e.message, 'mal', 'No se pudo registrar');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  }
}

// ── Checklist ────────────────────────────────────────────────────────────────
function modalChecklist() {
  const fila = ([clave, et], estados, pre) => `
    <div class="chk-item">
      <span class="nm">${et}</span>
      <select class="inp" data-item="${clave}">
        ${estados.map(e => `<option value="${e}" ${e === pre ? 'selected' : ''}>${e[0].toUpperCase() + e.slice(1)}</option>`).join('')}
      </select>
    </div>`;

  abrirModal('Checklist de salida', `
    <div class="chk-sec">Distintivos del vehículo (5)</div>
    ${DISTINTIVOS.map(d => fila(d, EST_DISTINTIVO, 'bueno')).join('')}
    <div class="chk-sec">Elementos (4)</div>
    ${ELEMENTOS.map(d => fila(d, EST_ELEMENTO, 'presente')).join('')}
    <div class="campo" style="margin-top:1rem"><label class="lb">Chalecos disponibles</label>
      <input class="inp" id="chk-chalecos" type="number" inputmode="numeric" placeholder="Cantidad"></div>
    <div class="campo"><label class="lb">Observaciones</label>
      <textarea class="inp" id="chk-obs" rows="2" placeholder="Opcional"></textarea></div>
    <div class="nota">Un distintivo <b>obstruido</b> —tapado por barro, lona o equipaje— cuenta
    como faltante: si no se ve, no protege.</div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn" id="chk-btn" onclick="guardarChecklist()">Guardar checklist</button>`);
}

async function guardarChecklist() {
  const btn = $('#chk-btn');
  const items = $$('#modal-cpo select[data-item]').map(s => ({
    item: s.dataset.item,
    estado: s.value,
    cantidad: s.dataset.item === 'chaleco' && $('#chk-chalecos').value
      ? Number($('#chk-chalecos').value) : undefined,
    observacion: $('#chk-obs').value.trim() || undefined,
  }));
  const vehiculoId = diaActual?.itinerario?.vehiculo_id || diaActual?.trayecto_abierto?.vehiculo_id;
  if (!vehiculoId) return aviso('No hay vehículo asignado hoy', 'mal', 'No se puede guardar');

  btn.disabled = true; btn.textContent = 'Guardando...';
  try {
    const r = await api('/api/checklists', {
      metodo: 'POST',
      cuerpo: {
        vehiculo_id: vehiculoId,
        trayecto_id: diaActual?.trayecto_abierto?.id,
        momento: diaActual?.trayecto_abierto ? 'regreso' : 'presalida',
        items,
      },
    });
    cerrarModal();
    aviso(r.faltantes
      ? `Registrado con ${r.faltantes} novedad(es). Quedó reportado.`
      : 'Checklist completo, todo en orden', r.faltantes ? 'avi' : 'ok', 'Listo');
  } catch (e) {
    // El servidor puede bloquear la salida si falta un distintivo.
    aviso(e.message, 'mal', 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar checklist';
  }
}

// ── Novedades ────────────────────────────────────────────────────────────────
function modalEvento() {
  abrirModal('Reportar novedad', `
    <div class="campo"><label class="lb">Tipo <span class="req">*</span></label>
      <select class="inp" id="ev-tipo">${TIPOS_EVENTO.map(([v, e]) => `<option value="${v}">${e}</option>`).join('')}</select></div>
    <div class="campo"><label class="lb">Gravedad</label>
      <select class="inp" id="ev-grav">
        <option value="baja">Baja</option><option value="media" selected>Media</option>
        <option value="alta">Alta</option><option value="critica">Crítica</option></select></div>
    <div class="campo"><label class="lb">Municipio</label>
      <select class="inp" id="ev-mun"><option value="">— Seleccione —</option>
        ${cat.municipios.map(m => `<option value="${m.id}">${esc(m.nombre)}</option>`).join('')}</select></div>
    <div class="campo"><label class="lb">Lugar</label><input class="inp" id="ev-lugar"></div>
    <div class="campo"><label class="lb">Qué pasó <span class="req">*</span></label>
      <textarea class="inp" id="ev-desc" rows="3"></textarea></div>
    <div class="campo"><label class="lb">Qué se hizo</label>
      <textarea class="inp" id="ev-acc" rows="2"></textarea></div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn ambar" id="ev-btn" onclick="guardarEvento()">Reportar</button>`);
}

async function guardarEvento() {
  const desc = $('#ev-desc').value.trim();
  if (!desc) return aviso('Describa qué pasó', 'mal', 'Falta la descripción');
  const btn = $('#ev-btn'); btn.disabled = true; btn.textContent = 'Enviando...';
  const geo = await ubicacion();
  try {
    await api('/api/eventos', {
      metodo: 'POST',
      cuerpo: {
        tipo: $('#ev-tipo').value, gravedad: $('#ev-grav').value,
        municipio_id: $('#ev-mun').value ? Number($('#ev-mun').value) : undefined,
        lugar: $('#ev-lugar').value.trim() || undefined,
        descripcion: desc, acciones: $('#ev-acc').value.trim() || undefined,
        trayecto_id: diaActual?.trayecto_abierto?.id,
        vehiculo_id: diaActual?.itinerario?.vehiculo_id,
        ...geo,
      },
    });
    cerrarModal();
    aviso('La novedad quedó reportada', 'ok', 'Listo');
    if (vistaActual === 'eventos') verEventos();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo reportar');
    btn.disabled = false; btn.textContent = 'Reportar';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ITINERARIO — la matriz que reemplaza el Excel
// ═══════════════════════════════════════════════════════════════════════════

let itinDesde = null, itinDatos = [], predeterminados = [];
/** vehiculo_id -> { dias, con_salida, primera, ultima } de TODA la operación. */
let totalesItin = new Map();
/** vehiculo_id -> { dias, dias_mantenimiento } fuera de servicio (D33). */
let totalesFSItin = new Map();
// En el celular dos semanas obligan a un desplazamiento lateral largo: se
// arranca en una. Si el usuario escoge otro período, manda el suyo.
let itinDias = Number(localStorage.getItem('flota_itin_dias')) || (angosta() ? 7 : 14);

/**
 * Cómo se presenta el itinerario en el celular: 'matriz' es la misma tabla
 * del escritorio, desplazable de lado; 'dia' es un día a la vez con todos los
 * vehículos en vertical. Las dos editan igual. En pantalla ancha siempre es la
 * matriz, que cabe entera.
 */
let modoItin = localStorage.getItem('flota_itin_modo') || 'matriz';
/** Día que se está viendo en el modo 'dia'. */
let itinDiaSel = null;

async function verItinerario() {
  if (!itinDesde) {
    // Arranca el lunes de la semana en curso
    const d = new Date(hoy() + 'T12:00:00');
    itinDesde = nDias(hoy(), -((d.getDay() + 6) % 7));
  }
  const hasta = nDias(itinDesde, itinDias - 1);

  $('#main').innerHTML = '<div class="cargando">Cargando itinerario...</div>';
  try {
    let resumen, periodosFS, resumenFS;
    [itinDatos, predeterminados, resumen, periodosFS, resumenFS] = await Promise.all([
      api(`/api/itinerario?desde=${itinDesde}&hasta=${hasta}`),
      api('/api/predeterminados'),
      // Los totales NO salen del período visible: se piden aparte, de toda la
      // operación. Si este endpoint falla —por ejemplo contra un Worker viejo—
      // el itinerario se dibuja igual, sin contador, que es mejor que no abrir.
      api('/api/itinerario/resumen').catch(() => null),
      api(`/api/fuera-servicio?desde=${itinDesde}&hasta=${hasta}`).catch(() => []),
      api('/api/fuera-servicio/resumen').catch(() => null),
    ]);
    totalesItin = new Map((resumen?.vehiculos || []).map(v => [v.vehiculo_id, v]));
    totalesFSItin = new Map((resumenFS?.vehiculos || []).map(v => [v.vehiculo_id, v]));
    indexarFS(periodosFS, Array.from({ length: itinDias }, (_, i) => nDias(itinDesde, i)));
  } catch (e) {
    return $('#main').innerHTML = `<div class="card"><div class="nota avi">${esc(e.message)}</div></div>`;
  }

  const dias = Array.from({ length: itinDias }, (_, i) => nDias(itinDesde, i));
  const activos = vehiculos.filter(v => v.activo !== 0);
  const porClave = {};
  itinDatos.forEach(i => { porClave[i.fecha + '|' + i.vehiculo_id] = i; });

  const celda = (v, f) => {
    const it = porClave[f + '|' + v.id];
    const fs = fsDe(f, v.id);
    const datos = `data-vehiculo-id="${v.id}" data-fecha="${f}"${it ? ` data-itin-id="${it.id}"` : ''}`;
    // Un día en que el vehículo está parado se ve, programado o no: sin esto,
    // una casilla vacía de un vehículo en el taller invita a adjudicarle un
    // traslado que no puede hacer.
    const marcaFS = fs
      ? `<span class="fs-marca" title="${esc(causaEt(fs.causa))}, desde el ${esc(fs.fecha_inicio)}${
          fs.fecha_fin ? ' hasta el ' + esc(fs.fecha_fin) : ''}">fuera de servicio</span>`
      : '';
    if (!it) {
      return `<td style="padding:.2rem"><div class="itin-celda vacia${fs ? ' fs' : ''}" ${datos}
        onpointerdown="itinPointerDown(event,null,${v.id},'${f}')"
        onclick="if(!pincel)modalItinerario(null,${v.id},'${f}')">${
          fs ? marcaFS + '<div style="margin-top:.15rem">+</div>' : '+'}</div></td>`;
    }
    const tj = TIPOS_JORNADA[it.tipo_jornada] || TIPOS_JORNADA.ebs;
    const ejec = it.trayectos_cerrados > 0;
    const enBase = it.tipo_jornada === 'disponible';
    const titulo = enBase ? 'Disponible' : (it.destino || tj.et);
    const pie = enBase ? (it.municipio || 'en base') : tj.et;
    // Un día ya ejecutado no se arrastra: la marca del conductor quedaría
    // apuntando a una programación que ya no describe lo que hizo.
    return `<td style="padding:.2rem"><div
      class="itin-celda ${it.tipo_jornada}${ejec ? ' bloqueada' : ''}${fs ? ' fs' : ''}" ${datos}
      ${ejec ? '' : `onpointerdown="itinPointerDown(event,${it.id},${v.id},'${f}')"`}
      title="${ejec ? 'Ya ejecutado: no se puede mover' : 'Arrastre para mover · con Ctrl para duplicar'}"
      onclick="if(!pincel)modalItinerario(${it.id},${v.id},'${f}')">
      <span class="dest">${esc(titulo)}</span>
      <span class="tj" style="color:var(--${tj.color === 'gris' ? 'muted' : tj.color})">${esc(pie)}</span>
      ${marcaFS}
      <div class="marcas">
        <span class="punto ${ejec ? 'ok' : 'no'}" title="${ejec ? 'Ejecutado' : 'Sin marcar'}"></span>
        <span style="font-size:.62rem;color:var(--muted)">${ejec ? 'ejecutado' : 'pendiente'}</span>
        ${it.num_cambios ? `<span class="mini-cambios" title="${it.num_cambios} modificación(es)">✎${it.num_cambios}</span>` : ''}
      </div></div></td>`;
  };

  const rotulo = f => {
    const esHoy = f === hoy();
    return `<th style="${esHoy ? 'color:var(--azul)' : ''}">
      ${diaSemana(f).slice(0, 3)}<br>
      <span style="font-weight:800;font-size:.9rem">${f.slice(8)}</span>
      <span style="font-weight:500;text-transform:none">/${f.slice(5, 7)}</span></th>`;
  };

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Itinerario</h1>
        <p>Programación de vehículos y conductores. Cada cambio queda registrado con su autor.</p></div>
      <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
        ${angosta() ? `<button class="btn sec sm" onclick="cambiarModoItin()"
          title="Cambiar entre la matriz y la vista por día">${
            modoItin === 'dia' ? 'Ver matriz' : 'Ver por día'}</button>` : ''}
        <button class="btn sec sm" onclick="moverItin(-itinDias)">←</button>
        <button class="btn sec sm" onclick="itinDesde=null;verItinerario()">Hoy</button>
        <button class="btn sec sm" onclick="moverItin(itinDias)">→</button>
        <select class="inp" style="width:auto;padding:.3rem .5rem;font-size:.8rem"
          onchange="cambiarPeriodo(this.value)">
          <option value="7"  ${itinDias === 7  ? 'selected' : ''}>1 semana</option>
          <option value="14" ${itinDias === 14 ? 'selected' : ''}>2 semanas</option>
          <option value="31" ${itinDias === 31 ? 'selected' : ''}>1 mes</option>
        </select>
        <button class="btn sec sm" onclick="sincronizarAhora()" id="btn-sincronizar"
          title="Traer los cambios hechos por otros usuarios">Actualizar</button>
        <button class="btn sec sm" onclick="deshacerMovimiento()" id="btn-deshacer">Deshacer</button>
        <button class="btn sec sm" onclick="modalPredeterminados()">Predeterminados</button>
        <button class="btn sec sm" onclick="descargarPDF()">PDF</button>
        <button class="btn sec sm" onclick="descargarPlantilla()">Excel</button>
        <button class="btn sec sm" onclick="$('#archivo-itin').click()">Cargar</button>
        <input type="file" id="archivo-itin" accept=".xlsx,.xls" style="display:none"
          onchange="cargarPlantilla(this)">
        <button class="btn sm" onclick="modalCopiarSemana()">Copiar período</button>
      </div>
    </div>

    ${predeterminados.length ? `
      <div class="card" style="padding:.6rem .8rem;margin-bottom:.85rem">
        <div class="pincel-fila" style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">
            Pincel</span>
          ${predeterminados.slice(0, 10).map(p => `<button class="pred-chip pincel-chip"
            data-id="${p.id}" onclick="activarPincel(${p.id})">${esc(p.nombre)}</button>`).join('')}
          <span style="font-size:.72rem;color:var(--muted)">
            ${tactil() ? 'Escoja uno y toque los días para programarlos'
                       : 'Escoja uno y arrastre sobre los días para programarlos'}</span>
        </div>
      </div>` : ''}

    ${!activos.length ? `
      <div class="card"><div class="vacio">
        <p>Todavía no hay vehículos registrados.</p>
        ${sesion.rol === 'principal'
          ? '<button class="btn" onclick="ir(\'vehiculos\')">Registrar el primero</button>'
          : '<p style="font-size:.85rem">El administrador debe registrarlos primero.</p>'}
      </div></div>` : `
      ${angosta() && modoItin === 'dia' ? vistaPorDia(dias, activos, porClave) : `
      <div class="scroll-arriba" id="scroll-arriba"><div id="scroll-ancho"></div></div>
      <div class="tabla-env" id="itin-env"><table>
        <thead><tr>
          <th class="itin-th-veh">Vehículo</th>
          ${dias.map(rotulo).join('')}
        </tr></thead>
        <tbody>${(() => {
          // La media, para el color, se calcula sobre los mismos totales: si se
          // mezclara el total de un vehículo con la media del período visible el
          // desvío no querría decir nada.
          const conTotal = activos.map(v => totalesItin.get(v.id)?.dias || 0);
          const media = conTotal.length
            ? conTotal.reduce((a, b) => a + b, 0) / conTotal.length : 0;
          return activos.map(v => {
          const tot = totalesItin.get(v.id);
          const enPeriodo = itinDatos.filter(i => i.vehiculo_id === v.id && i.estado !== 'cancelado').length;
          const diasTotal = tot?.dias || 0;
          const conDespl = tot?.con_salida || 0;
          const desvio = diasTotal - media;
          const color = Math.abs(desvio) < 1.5 ? 'muted' : desvio > 0 ? 'ambar' : 'azul';
          return `
          <tr>
            <td class="itin-td-veh">
              <div class="placa">${esc(v.placa)}</div>
              <div class="cond-fila" title="${esc(v.conductor_actual || 'Sin conductor')}"
                >${esc(v.conductor_actual || 'Sin conductor')}</div>
              <div style="font-size:.68rem;margin-top:.2rem;color:var(--${color});font-weight:700"
                title="Total programado en toda la operación${tot?.primera ? ` (desde ${tot.primera})` : ''}
 · ${conDespl} con desplazamiento · ${enPeriodo} en el período que está viendo">
                ${diasTotal} día(s) · ${conDespl} con salida
              </div>
              ${(() => {
                const fs = totalesFSItin.get(v.id);
                return `<button class="fs-boton ${fs?.dias ? 'con' : ''}" onclick="modalFueraServicio(${v.id})"
                  title="Días en que no pudo operar${fs?.dias_mantenimiento
                    ? `, de los cuales ${fs.dias_mantenimiento} de mantenimiento programado` : ''}">
                  ${fs?.dias ? `${fs.dias} día(s) fuera de servicio` : 'Registrar avería'}</button>`;
              })()}
              ${v.docs_vencidos ? `<div class="etq rojo" style="margin-top:.2rem;font-size:.62rem"
                title="${esc(v.docs_vencidos_tipos || '')}">${v.docs_vencidos} doc. vencido(s)</div>` : ''}
            </td>
            ${dias.map(f => celda(v, f)).join('')}
          </tr>`; }).join(''); })()}</tbody>
      </table></div>`}

      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.85rem;font-size:.75rem;color:var(--muted)">
        ${Object.entries(TIPOS_JORNADA).map(([k, t]) =>
          `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--${t.color === 'gris' ? 'muted' : t.color});vertical-align:middle"></span> ${t.et}</span>`).join('')}
        <span><span class="punto ok"></span> ejecutado (el conductor marcó salida)</span>
        <span><span class="fs-marca">fuera de servicio</span> no cuenta como día pagable</span>
        <span><span class="mini-cambios">✎</span> modificado</span>
        <span>${angosta() && modoItin === 'dia'
          ? 'Toque un vehículo libre para adjudicarle el día'
          : angosta()
          ? 'Toque un día para programarlo · sostenga el dedo sobre uno ya programado para moverlo'
          : 'Arrastre una celda para moverla · mantenga <b>Ctrl</b> para duplicarla · sostenga el dedo en el celular'}</span>
      </div>`}
  `;
  sincronizarScroll();
  // El redibujado rehace las fichas: se vuelve a marcar la del pincel activo.
  if (pincel) {
    $$('.pincel-chip').forEach(c => c.classList.toggle('activo', Number(c.dataset.id) === pincel.id));
    marcarPintando(true);
  }
  // La tira de días es más ancha que la pantalla: si el día escogido queda
  // fuera, no se ve cuál está seleccionado.
  $('#tira-dias .d.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

/** Marca el modo pintar en la vista que esté puesta, matriz o por día. */
function marcarPintando(si) {
  $('#itin-env')?.classList.toggle('pintando', si);
  $('#itin-dia')?.classList.toggle('pintando', si);
}

/**
 * Barra de desplazamiento espejo encima de la tabla.
 *
 * Con 14 columnas la barra del navegador queda al pie, fuera de la pantalla:
 * hay que bajar hasta el último vehículo para poder desplazarse. Esta es una
 * segunda barra arriba, sincronizada con la tabla en ambos sentidos.
 */
let observadorScroll = null;

function sincronizarScroll() {
  // Cada redibujado crea una tabla nueva; sin esto quedan observadores vivos
  // apuntando a elementos que ya se fueron del documento.
  observadorScroll?.disconnect();
  observadorScroll = null;

  const arriba = $('#scroll-arriba'), env = $('#itin-env');
  if (!arriba || !env) return;
  const tabla = env.querySelector('table');
  if (!tabla) return;

  const ajustar = () => {
    const ancho = $('#scroll-ancho');
    if (ancho) ancho.style.width = tabla.scrollWidth + 'px';
  };
  ajustar();
  if (window.ResizeObserver) {
    observadorScroll = new ResizeObserver(ajustar);
    observadorScroll.observe(tabla);
  }

  let eco = false;                       // evita que se empujen mutuamente
  arriba.onscroll = () => { if (eco) return; eco = true; env.scrollLeft = arriba.scrollLeft; eco = false; };
  env.onscroll = () => { if (eco) return; eco = true; arriba.scrollLeft = env.scrollLeft; eco = false; };
}

// ── Arrastrar, pintar y deshacer ─────────────────────────────────────────────
//
// Se usa Pointer Events en vez de la API de arrastre de HTML5 porque esa no
// existe en pantallas táctiles: el mismo código sirve para el ratón en el
// computador y para el dedo en el celular.
//
// En táctil hay un conflicto: arrastrar para mover y arrastrar para desplazar
// la tabla son el mismo gesto. Se resuelve con una pulsación sostenida — hasta
// que pasan 350 ms el gesto sigue siendo un desplazamiento normal.

const ESPERA_TACTIL = 350;      // ms sostenidos antes de empezar a mover
const UMBRAL = 8;               // px de movimiento que cancelan la pulsación

let arrastre = null;            // { id, fantasma, listo, temporizador }
let pincel = null;              // predeterminado activo en modo pintar
let ultimoMovimiento = null;    // para deshacer

function celdaDesde(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  return el?.closest?.('.itin-celda') || null;
}

function itinPointerDown(ev, id, vehiculoId, fecha) {
  if (ev.button != null && ev.button !== 0) return;      // solo botón principal

  if (pincel) { pintarCelda(vehiculoId, fecha, id); return; }
  if (!id) return;                                        // celda vacía: no hay qué mover

  const celda = ev.currentTarget;
  const tactil = ev.pointerType === 'touch';
  const iniciar = () => {
    arrastre.listo = true;
    celda.classList.add('arrastrando');
    if (navigator.vibrate) navigator.vibrate(12);
    arrastre.fantasma = document.createElement('div');
    arrastre.fantasma.className = 'fantasma';
    arrastre.fantasma.textContent = celda.querySelector('.dest')?.textContent || '';
    document.body.appendChild(arrastre.fantasma);
    moverFantasma(ev);
  };

  arrastre = { id, celda, x0: ev.clientX, y0: ev.clientY, listo: false, temporizador: null };
  if (tactil) arrastre.temporizador = setTimeout(iniciar, ESPERA_TACTIL);
  else iniciar();
}

function moverFantasma(ev) {
  if (!arrastre?.fantasma) return;
  arrastre.fantasma.style.left = ev.clientX + 'px';
  arrastre.fantasma.style.top = ev.clientY + 'px';
}

function itinPointerMove(ev) {
  if (!arrastre) return;

  if (!arrastre.listo) {
    // Se movió antes de tiempo: era un desplazamiento, no un arrastre.
    const d = Math.hypot(ev.clientX - arrastre.x0, ev.clientY - arrastre.y0);
    if (d > UMBRAL) { clearTimeout(arrastre.temporizador); arrastre = null; }
    return;
  }

  ev.preventDefault();
  moverFantasma(ev);
  $$('.itin-celda').forEach(c => c.classList.remove('destino-ok', 'destino-cambio', 'destino-no'));
  const sobre = celdaDesde(ev);
  if (!sobre || sobre === arrastre.celda) return;

  const { vehiculoId, fecha } = sobre.dataset;
  const destino = itinDatos.find(x => x.fecha === fecha && x.vehiculo_id == vehiculoId
                                     && x.estado !== 'cancelado');
  const duplicando = ev.ctrlKey || ev.metaKey || ev.altKey;
  const noSePuede = (destino && destino.trayectos_cerrados > 0) || (duplicando && destino);
  sobre.classList.add(noSePuede ? 'destino-no' : destino ? 'destino-cambio' : 'destino-ok');
}

async function itinPointerUp(ev) {
  if (!arrastre) return;
  clearTimeout(arrastre.temporizador);
  const { id, listo, celda, fantasma } = arrastre;
  arrastre = null;
  fantasma?.remove();
  celda?.classList.remove('arrastrando');
  $$('.itin-celda').forEach(c => c.classList.remove('destino-ok', 'destino-cambio', 'destino-no'));
  if (!listo) return;

  const sobre = celdaDesde(ev);
  if (!sobre || sobre === celda) return;
  const { vehiculoId, fecha } = sobre.dataset;
  const duplicar = ev.ctrlKey || ev.metaKey || ev.altKey;

  const origen = itinDatos.find(x => x.id === id);
  try {
    const r = await api('/api/itinerario/mover', {
      metodo: 'POST', cuerpo: { id, fecha, vehiculo_id: Number(vehiculoId), duplicar },
    });
    if (r.sin_cambios) return;
    ultimoMovimiento = duplicar
      ? { tipo: 'duplicado', id: r.id }
      : { tipo: 'movido', id, fecha: origen.fecha, vehiculo_id: origen.vehiculo_id };
    aviso(duplicar ? 'Duplicada' : r.intercambio ? 'Intercambiadas' : 'Movida', 'ok');
    verItinerario();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo mover');
  }
}

/** Deshace el último arrastre: lo devuelve a su sitio, o borra el duplicado. */
async function deshacerMovimiento() {
  if (!ultimoMovimiento) return;
  const u = ultimoMovimiento;
  ultimoMovimiento = null;
  try {
    if (u.tipo === 'duplicado') {
      await api(`/api/itinerario/${u.id}?definitivo=1`, { metodo: 'DELETE', cuerpo: {} });
    } else {
      await api('/api/itinerario/mover', {
        metodo: 'POST',
        cuerpo: { id: u.id, fecha: u.fecha, vehiculo_id: u.vehiculo_id, motivo: 'Deshecho' },
      });
    }
    aviso('Se deshizo el último movimiento', 'ok');
    verItinerario();
  } catch (e) { aviso(e.message, 'mal', 'No se pudo deshacer'); }
}

// ── Pintar con un predeterminado ─────────────────────────────────────────────

function activarPincel(id) {
  pincel = pincel?.id === id ? null : predeterminados.find(p => p.id === id);
  $$('.pincel-chip').forEach(c =>
    c.classList.toggle('activo', pincel && Number(c.dataset.id) === pincel.id));
  marcarPintando(!!pincel);
  aviso(pincel ? `Pincel: ${pincel.nombre}. ${tactil()
                   ? 'Toque los días que quiera programar.'
                   : 'Toque o arrastre sobre los días.'}`
               : 'Pincel apagado', pincel ? 'ok' : 'info');
}

let pintando = new Set();       // celdas ya tocadas en el trazo actual
let tareasPintura = [];         // guardados en vuelo
let pintadasEnTrazo = 0;

/**
 * Programa una celda con el pincel activo.
 *
 * No se espera aquí: el trazo puede pasar por diez celdas y cada una dispara su
 * guardado. La tarea se apunta y `pincelFin` espera a todas antes de redibujar;
 * si se redibujara antes, la pantalla mostraría el estado anterior.
 */
function pintarCelda(vehiculoId, fecha, idExistente) {
  if (!pincel) return;
  const clave = `${fecha}|${vehiculoId}`;
  if (pintando.has(clave)) return;                    // ya se pintó en este trazo
  pintando.add(clave);
  tareasPintura.push(guardarPintura(vehiculoId, fecha, idExistente));
}

async function guardarPintura(vehiculoId, fecha, idExistente) {
  try {
    if (idExistente) {
      await api('/api/itinerario/' + idExistente, {
        metodo: 'PUT',
        cuerpo: { tipo_jornada: pincel.tipo_jornada, municipio_id: pincel.municipio_id,
                  destino_id: pincel.destino_id, observaciones: pincel.observaciones,
                  motivo: `Pintado con "${pincel.nombre}"` },
      });
    } else {
      await api('/api/itinerario', {
        metodo: 'POST',
        cuerpo: { fecha, vehiculo_id: Number(vehiculoId), predeterminado_id: pincel.id,
                  conductor_id: vehiculos.find(v => v.id == vehiculoId)?.conductor_id || null },
      });
    }
    pintadasEnTrazo++;
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo pintar');
  }
}

function pincelMove(ev) {
  if (!pincel || !ev.buttons) return;
  // Con el dedo el pincel es solo por toques: arrastrar es desplazar la
  // pantalla, y si aquí se llamara a preventDefault la tabla se quedaría
  // pegada mientras el pincel estuviera encendido.
  if (ev.pointerType === 'touch') return;
  const sobre = celdaDesde(ev);
  if (!sobre) return;
  ev.preventDefault();
  const { vehiculoId, fecha, itinId } = sobre.dataset;
  pintarCelda(vehiculoId, fecha, itinId ? Number(itinId) : null);
}

async function pincelFin() {
  if (!pincel || !tareasPintura.length) return;
  const tareas = tareasPintura;
  tareasPintura = [];
  pintando.clear();
  await Promise.all(tareas);                 // sin esto se redibuja antes de tiempo
  if (!pintadasEnTrazo) return;
  aviso(`${pintadasEnTrazo} día(s) programado(s)`, 'ok', 'Listo');
  pintadasEnTrazo = 0;
  await verItinerario();
}

document.addEventListener('pointermove', ev => { itinPointerMove(ev); pincelMove(ev); },
                          { passive: false });
document.addEventListener('pointerup', ev => { itinPointerUp(ev); pincelFin(); });
let eraAngosta = angosta();
window.addEventListener('resize', () => {
  if (angosta() === eraAngosta) return;
  eraAngosta = angosta();
  if (vistaActual === 'itinerario') verItinerario();
});

document.addEventListener('pointercancel', () => {
  arrastre?.fantasma?.remove();
  arrastre?.celda?.classList.remove('arrastrando');
  arrastre = null;
  pincelFin();
});

// ── Navegación del rango ────────────────────────────────────────────────────

/**
 * El itinerario en el celular, un día a la vez.
 *
 * La matriz de 13 vehículos por 14 días mide unos 1.700 px: en un teléfono se
 * ven dos días y medio a la vez, así que adjudicar exige buscar la celda
 * desplazándose. Esta vista muestra el MISMO itinerario, editable igual, pero
 * de otra forma: se escoge el día en la tira de arriba y debajo salen TODOS
 * los vehículos, los programados con su destino y —esto es lo que faltaba—
 * los libres como una ranura que se toca para adjudicar.
 *
 * Los vehículos van en el mismo orden que las filas de la matriz: quien
 * programa busca por placa y no tiene que aprenderse dos ordenaciones.
 */
function vistaPorDia(dias, activos, porClave) {
  // El día escogido tiene que estar dentro del período visible: si se movió el
  // período o se cambió su largo, el anterior puede haberse quedado fuera.
  if (!dias.includes(itinDiaSel)) {
    itinDiaSel = dias.includes(hoy()) ? hoy() : dias[0];
  }
  const f = itinDiaSel;
  const i = dias.indexOf(f);

  const filas = activos.map(v => ({ v, it: porClave[f + '|' + v.id] }));
  const ocupados = filas.filter(x => x.it).length;

  const tira = dias.map(d => {
    const n = activos.reduce((a, v) => a + (porClave[d + '|' + v.id] ? 1 : 0), 0);
    return `<div class="d ${d === f ? 'on' : ''} ${d === hoy() ? 'hoy' : ''}"
      onclick="verDiaItin('${d}')" title="${diaSemana(d)} ${d}">
      ${diaSemana(d).slice(0, 3)}<span class="n">${d.slice(8)}</span>
      <span class="c">${n || '·'}</span></div>`;
  }).join('');

  const renglon = ({ v, it }) => {
    const conductor = v.conductor_actual?.trim() || 'sin conductor';
    const fs = fsDe(f, v.id);
    if (!it) {
      return `<div class="itin-ren libre${fs ? ' fs' : ''}" data-vehiculo-id="${v.id}" data-fecha="${f}"
        onclick="tocarRenItin(null,${v.id},'${f}')">
        <span class="pl">${esc(v.placa)}</span>
        <span class="de"><span class="sub">${esc(conductor)} · ${fs
          ? 'fuera de servicio (' + esc(causaEt(fs.causa)) + ')' : 'sin programación'}</span></span>
        <span class="mas">+ Asignar</span></div>`;
    }
    const tj = TIPOS_JORNADA[it.tipo_jornada] || TIPOS_JORNADA.ebs;
    const ejec = it.trayectos_cerrados > 0;
    const enBase = it.tipo_jornada === 'disponible';
    return `<div class="itin-ren ${it.tipo_jornada}${ejec ? ' bloqueada' : ''}${fs ? ' fs' : ''}"
      data-vehiculo-id="${v.id}" data-fecha="${f}" data-itin-id="${it.id}"
      onclick="tocarRenItin(${it.id},${v.id},'${f}')">
      <span class="pl">${esc(v.placa)}</span>
      <span class="de"><b>${esc(enBase ? 'Disponible' : (it.destino || tj.et))}</b><br>
        <span class="sub">${fs
          ? '<b style="color:var(--rojo)">Fuera de servicio</b> · ' + esc(conductor)
          : esc(conductor)}</span></span>
      <span class="etq ${tj.color}">${tj.et}</span>
      ${ejec ? '<span class="punto ok" title="Ejecutado"></span>' : ''}
      ${it.num_cambios ? `<span class="mini-cambios" title="${it.num_cambios} modificación(es)">✎${it.num_cambios}</span>` : ''}
    </div>`;
  };

  return `
    <div class="tira-dias" id="tira-dias">${tira}</div>
    <div class="dia-nav">
      <button class="btn sec sm" ${i > 0 ? `onclick="verDiaItin('${dias[i - 1]}')"` : 'disabled'}>←</button>
      <div class="tit">${diaSemana(f)} ${new Date(f + 'T12:00:00')
        .toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}
        ${f === hoy() ? '<small>hoy</small>' : ''}</div>
      <button class="btn sec sm" ${i < dias.length - 1 ? `onclick="verDiaItin('${dias[i + 1]}')"` : 'disabled'}>→</button>
    </div>
    <div id="itin-dia">
      <p class="dia-res">${ocupados} programado(s) · ${filas.length - ocupados} libre(s)
        de ${filas.length} vehículo(s)${(() => {
          const n = filas.filter(x => fsDe(f, x.v.id)).length;
          return n ? ` · <b style="color:var(--rojo)">${n} fuera de servicio</b>` : '';
        })()}</p>
      ${filas.map(renglon).join('')}
    </div>`;
}

/** Cambia el día que se está viendo, sin volver a pedirle nada al servidor. */
function verDiaItin(f) {
  itinDiaSel = f;
  verItinerario();
}

/** Alterna entre la matriz y la vista por día, y lo recuerda. */
function cambiarModoItin() {
  modoItin = modoItin === 'dia' ? 'matriz' : 'dia';
  localStorage.setItem('flota_itin_modo', modoItin);
  verItinerario();
}

/**
 * Toque sobre un renglón de la vista por día.
 *
 * Con el pincel encendido el toque programa directamente, que es lo que lo
 * hace rápido; sin él abre la ventana de siempre. Un día ya ejecutado no se
 * pinta: la marca del conductor quedaría apuntando a una programación que ya
 * no describe lo que hizo.
 */
function tocarRenItin(id, vehiculoId, fecha) {
  if (pincel) {
    const it = id ? itinDatos.find(x => x.id === id) : null;
    if (it?.trayectos_cerrados > 0) {
      return aviso('Ese día ya está ejecutado: no se puede pintar encima.', 'mal');
    }
    pintarCelda(vehiculoId, fecha, id);
    pincelFin();
    return;
  }
  modalItinerario(id, vehiculoId, fecha);
}

function moverItin(n) { itinDesde = nDias(itinDesde, n); verItinerario(); }

function cambiarPeriodo(dias) {
  itinDias = Number(dias);
  localStorage.setItem('flota_itin_dias', itinDias);
  verItinerario();
}

/** Programación abierta en la ventana; la consulta avisarMover(). */
let itinEnEdicion = null;

async function modalItinerario(id, vehiculoId, fecha) {
  const it = id ? itinDatos.find(x => x.id === id) : null;
  itinEnEdicion = it ? it.id : null;
  const conductores = personas.filter(p => p.es_conductor);
  const veh = vehiculos.find(v => v.id === vehiculoId);
  // En una programación nueva se propone el conductor predeterminado del vehículo.
  const condPropuesto = it ? it.conductor_id : (veh ? veh.conductor_id : null);

  const cond = personas.find(p => p.id === condPropuesto);
  const reparos = [];
  const fsDia = fsDe(fecha, vehiculoId);
  if (fsDia) {
    reparos.push(`<b>${esc(veh?.placa || '')}</b> está registrado <b>fuera de servicio</b> ` +
      `ese día (${esc(causaEt(fsDia.causa))}, desde el ${esc(fsDia.fecha_inicio)}` +
      `${fsDia.fecha_fin ? ' hasta el ' + esc(fsDia.fecha_fin) : ', sin fecha de regreso'}). ` +
      'Ese día no cuenta como pagable.');
  }
  if (veh?.docs_vencidos) {
    reparos.push(`<b>${esc(veh.placa)}</b> tiene vencido: ${esc(veh.docs_vencidos_tipos || 'documentos')}`);
  }
  if (veh && veh.estado && veh.estado !== 'activo') {
    reparos.push(`<b>${esc(veh.placa)}</b> está marcado como <b>${esc(veh.estado)}</b>`);
  }
  if (cond?.docs_vencidos) {
    reparos.push(`<b>${esc(cond.nombres)}</b> tiene vencido: ${esc(cond.docs_vencidos_tipos || 'documentos')}`);
  }

  abrirModal(it ? 'Modificar programación' : 'Adjudicar desplazamiento', `
    <div class="nota" style="margin-bottom:1rem">
      <b>${esc(veh?.placa || '')}</b> · ${diaSemana(fecha)}
      ${new Date(fecha + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}
    </div>
    ${reparos.length ? `<div class="nota avi" style="margin-bottom:1rem">
      <b>Revise antes de programar</b>
      <div style="margin-top:.25rem">${reparos.join('<br>')}</div>
      <div style="margin-top:.35rem;font-size:.78rem">
        Se puede programar igual; queda a su criterio.</div>
    </div>` : ''}
    ${predeterminados.length ? `
      <label class="lb">Predeterminados</label>
      <div class="pred-chips">
        ${predeterminados.map(p => `<button type="button" class="pred-chip"
          onclick="aplicarChip(${p.id})">${esc(p.nombre)}${p.veces_usado
            ? `<span class="veces">${p.veces_usado}</span>` : ''}</button>`).join('')}
      </div>` : `
      <div class="nota" style="margin-bottom:1rem">
        Aún no hay predeterminados. Llene los campos y use
        <b>Guardar como predeterminado</b> para no repetirlos cada vez.
      </div>`}
    <div class="campo"><label class="lb">Tipo de jornada <span class="req">*</span></label>
      <select class="inp" id="it-tipo" onchange="itinToggleDestino()">
        ${Object.entries(TIPOS_JORNADA).map(([k, t]) =>
          `<option value="${k}" ${it && it.tipo_jornada === k ? 'selected' : ''}>${t.et}</option>`).join('')}
      </select></div>
    <div class="campo"><label class="lb">Conductor</label>
      <select class="inp" id="it-cond"><option value="">— Sin asignar —</option>
        ${conductores.map(p => `<option value="${p.id}" ${condPropuesto == p.id ? 'selected' : ''}>${esc(p.nombres)} ${esc(p.apellidos || '')}</option>`).join('')}
      </select>
      ${!it && veh && veh.conductor_id ? `<p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0">
        Propuesto: conductor predeterminado de ${esc(veh.placa)}.</p>` : ''}</div>
    <div id="it-destino-bloque">
      <div class="campo"><label class="lb">Municipio</label>
        <select class="inp" id="it-mun"><option value="">— Seleccione —</option>
          ${cat.municipios.map(m => `<option value="${m.id}" ${it && it.municipio_id == m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('')}
        </select></div>
      <div class="campo"><label class="lb">Destino</label>
        <input class="inp" id="it-dest" list="lista-destinos" value="${esc(it?.destino || '')}"
          placeholder="Escriba el destino, o escójalo de la lista">
        <datalist id="lista-destinos">
          ${cat.destinos.map(d => `<option value="${esc(d.nombre)}">`).join('')}
        </datalist>
        <p style="font-size:.72rem;color:var(--muted);margin:.3rem 0 0">
          Si el destino es nuevo, escríbalo y queda guardado para la próxima vez.</p>
      </div>
    </div>
    <div class="campo"><label class="lb">Observaciones</label>
      <textarea class="inp" id="it-obs" rows="2">${esc(it?.observaciones || '')}</textarea></div>
    ${it ? `<div class="campo"><label class="lb">Motivo del cambio</label>
      <input class="inp" id="it-motivo" placeholder="Por qué se modifica (queda registrado)"></div>
    <details class="mover-bloque">
      <summary>Mover a otro día o a otro vehículo</summary>
      <div class="g2" style="display:grid;gap:.6rem;margin-top:.6rem">
        <div class="campo" style="margin:0"><label class="lb">Día</label>
          <input type="date" class="inp" id="it-fecha" value="${fecha}"
            onchange="avisarMover()"></div>
        <div class="campo" style="margin:0"><label class="lb">Vehículo</label>
          <select class="inp" id="it-veh" onchange="avisarMover()">
            ${vehiculos.filter(v => v.activo !== 0).map(v => `<option value="${v.id}"
              ${v.id === vehiculoId ? 'selected' : ''}>${esc(v.placa)}</option>`).join('')}
          </select></div>
      </div>
      <p id="it-mover-avi" class="ayuda"></p>
    </details>` : ''}
    ${it?.num_cambios ? `<button class="btn sec sm" onclick="verCambios(${it.id})">
      Ver historial de cambios (${it.num_cambios})</button>` : ''}`,
    `${it ? `<button class="btn sec" onclick="borrarItinerario(${it.id})">${
        sesion.rol === 'principal' ? 'Borrar' : 'Cancelar'}</button>` : ''}
     <button class="btn sec" onclick="guardarComoPredeterminado()">Guardar como predeterminado</button>
     <button class="btn sec" onclick="cerrarModal()">Cerrar</button>
     <button class="btn" id="it-btn" onclick="guardarItinerario(${id || 'null'},${vehiculoId},'${fecha}')">Guardar</button>`);
  itinToggleDestino();
}

/**
 * Avisa, antes de guardar, qué va a pasar con el destino escogido para mover.
 *
 * El servidor INTERCAMBIA las dos programaciones cuando el destino ya está
 * ocupado. Arrastrando en la matriz eso se ve venir —la celda se pinta de
 * ámbar—; desde esta ventana no se vería nada, y un intercambio silencioso
 * movería de sitio una programación que nadie tocó.
 */
function avisarMover() {
  const p = $('#it-mover-avi');
  if (!p) return;
  const f = $('#it-fecha').value, v = Number($('#it-veh').value);
  const it = itinDatos.find(x => x.id === itinEnEdicion);
  if (!f || !it || (f === it.fecha && v === Number(it.vehiculo_id))) {
    p.textContent = ''; p.className = 'ayuda'; return;
  }
  const dentro = f >= itinDesde && f <= nDias(itinDesde, itinDias - 1);
  if (!dentro) {
    p.className = 'ayuda';
    p.textContent = 'Ese día está fuera del período que está viendo: al guardar, '
      + 'la programación desaparece de esta pantalla (no se borra).';
    return;
  }
  const ocupa = itinDatos.find(x => x.fecha === f && Number(x.vehiculo_id) === v
                                    && x.estado !== 'cancelado' && x.id !== it.id);
  if (!ocupa) {
    p.className = 'ayuda';
    p.textContent = 'Ese día está libre para ese vehículo.';
  } else if (ocupa.trayectos_cerrados > 0) {
    p.className = 'ayuda mal';
    p.textContent = 'Ese día ya tiene viajes registrados: no se puede ocupar.';
  } else {
    p.className = 'ayuda mal';
    p.textContent = `Ese día ya está programado (${ocupa.destino
      || TIPOS_JORNADA[ocupa.tipo_jornada]?.et || 'ocupado'}): las dos se INTERCAMBIAN de sitio.`;
  }
}

function itinToggleDestino() {
  const t = $('#it-tipo').value;
  // Un día "disponible" es en base: no lleva destino.
  $('#it-destino-bloque').style.display = t === 'disponible' ? 'none' : '';
}

async function guardarItinerario(id, vehiculoId, fecha) {
  const btn = $('#it-btn'); btn.disabled = true; btn.textContent = 'Guardando...';
  const tipo = $('#it-tipo').value;
  const cuerpo = {
    fecha, vehiculo_id: vehiculoId,
    conductor_id: $('#it-cond').value ? Number($('#it-cond').value) : null,
    municipio_id: $('#it-mun').value ? Number($('#it-mun').value) : null,
    tipo_jornada: tipo,
    observaciones: $('#it-obs').value.trim() || null,
  };
  if (tipo !== 'disponible' && $('#it-dest').value.trim()) {
    cuerpo.destino_nombre = $('#it-dest').value.trim();
  }
  const motivo = id ? ($('#it-motivo')?.value.trim() || undefined) : undefined;
  if (id) cuerpo.motivo = motivo;

  // Mover va aparte: el PUT no cambia ni la fecha ni el vehículo. No puede,
  // porque la tabla tiene UNIQUE(fecha, vehiculo_id) y caer sobre una celda
  // ocupada exige el intercambio en tres pasos que hace /api/itinerario/mover.
  const fDestino = id ? ($('#it-fecha')?.value || fecha) : fecha;
  const vDestino = id ? Number($('#it-veh')?.value || vehiculoId) : Number(vehiculoId);
  const mueve = id && (fDestino !== fecha || vDestino !== Number(vehiculoId));

  try {
    // Primero mover: si el destino no se puede ocupar, se para aquí y no queda
    // la programación editada a medias, en un sitio que el usuario ya no espera.
    let intercambio = false;
    if (mueve) {
      const r = await api('/api/itinerario/mover', {
        metodo: 'POST',
        cuerpo: { id, fecha: fDestino, vehiculo_id: vDestino, motivo },
      });
      intercambio = !!r.intercambio;
      // Queda al alcance del botón Deshacer, igual que un arrastre.
      ultimoMovimiento = { tipo: 'movido', id, fecha, vehiculo_id: Number(vehiculoId) };
    }
    if (id) await api('/api/itinerario/' + id, { metodo: 'PUT', cuerpo });
    else await api('/api/itinerario', { metodo: 'POST', cuerpo });
    cerrarModal();
    const fuera = mueve && (fDestino < itinDesde || fDestino > nDias(itinDesde, itinDias - 1));
    aviso(!id ? 'Desplazamiento adjudicado'
          : intercambio ? 'Actualizada e intercambiada con la que ocupaba ese día'
          : mueve ? `Actualizada y movida al ${fDestino}${
              fuera ? ', que está fuera del período que está viendo' : ''}`
          : 'Programación actualizada', 'ok', 'Listo');
    cat = await api('/api/catalogos');   // recarga por si se creó un destino nuevo
    verItinerario();
  } catch (e) {
    aviso(e.message, 'mal', mueve ? 'No se pudo mover' : 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

/**
 * Coordinación cancela (queda registrada); el administrador puede además
 * borrar de verdad. Si el día ya tiene viajes, el servidor rechaza las dos.
 */
async function borrarItinerario(id) {
  const admin = sesion.rol === 'principal';
  abrirModal(admin ? 'Quitar programación' : 'Cancelar programación', `
    <div class="campo"><label class="lb">Motivo</label>
      <input class="inp" id="bo-motivo" placeholder="Por qué se quita (queda registrado)"></div>
    ${admin ? `
      <div class="campo">
        <label style="display:flex;gap:.5rem;align-items:flex-start;font-size:.86rem;cursor:pointer">
          <input type="checkbox" id="bo-definitivo" style="margin-top:.2rem">
          <span><b>Borrar definitivamente</b><br>
            <span style="color:var(--muted);font-size:.8rem">Sin esta casilla queda cancelada y
            visible en el historial. Con ella se elimina junto con su historial de cambios.</span>
          </span></label>
      </div>` : `
      <div class="nota">Queda marcada como cancelada y se puede consultar después.
        Solo el administrador puede borrarla del todo.</div>`}`,
    `<button class="btn sec" onclick="cerrarModal()">Volver</button>
     <button class="btn rojo" id="bo-btn" onclick="confirmarBorrado(${id})">Confirmar</button>`);
}

async function confirmarBorrado(id) {
  const btn = $('#bo-btn'); btn.disabled = true; btn.textContent = 'Quitando...';
  const definitivo = $('#bo-definitivo')?.checked;
  try {
    await api(`/api/itinerario/${id}${definitivo ? '?definitivo=1' : ''}`, {
      metodo: 'DELETE', cuerpo: { motivo: $('#bo-motivo').value.trim() || null },
    });
    cerrarModal();
    aviso(definitivo ? 'Programación borrada' : 'Programación cancelada', 'ok', 'Listo');
    verItinerario();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo quitar');
    btn.disabled = false; btn.textContent = 'Confirmar';
  }
}

// ── Banco de predeterminados ─────────────────────────────────────────────────

/** Vuelca un predeterminado sobre los campos del formulario abierto. */
function aplicarChip(id) {
  const p = predeterminados.find(x => x.id === id);
  if (!p) return;
  $('#it-tipo').value = p.tipo_jornada;
  $('#it-mun').value = p.municipio_id || '';
  $('#it-dest').value = p.destino || '';
  if (p.observaciones) $('#it-obs').value = p.observaciones;
  itinToggleDestino();
  aviso(`Aplicado: ${p.nombre}`, 'ok');
}

function guardarComoPredeterminado() {
  const tipo = $('#it-tipo').value, dest = $('#it-dest').value.trim();
  const mun = $('#it-mun').value;
  const sugerido = tipo === 'disponible'
    ? 'Disponible ' + (cat.municipios.find(m => m.id == mun)?.nombre || '')
    : `${TIPOS_JORNADA[tipo].et} ${dest}`.trim();

  abrirModal('Guardar como predeterminado', `
    <p style="font-size:.87rem;color:var(--text-soft);margin:0 0 1rem">
      Queda en el banco para adjudicarlo con un clic, y es el valor que se escribe
      en la plantilla de Excel.</p>
    <div class="campo"><label class="lb">Nombre <span class="req">*</span></label>
      <input class="inp" id="gp-nombre" value="${esc(sugerido)}"></div>
    <div class="nota">
      ${TIPOS_JORNADA[tipo].et}${dest ? ' · ' + esc(dest) : ''}${
        mun ? ' · ' + esc(cat.municipios.find(m => m.id == mun)?.nombre || '') : ''}
    </div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn" id="gp-btn" onclick="crearPredeterminado('${tipo}','${esc(dest)}',${mun || 'null'})">Guardar</button>`);
}

async function crearPredeterminado(tipo, destino, municipioId) {
  const nombre = $('#gp-nombre').value.trim();
  if (!nombre) return aviso('Póngale un nombre', 'mal');
  const btn = $('#gp-btn'); btn.disabled = true; btn.textContent = 'Guardando...';
  try {
    await api('/api/predeterminados', {
      metodo: 'POST',
      cuerpo: {
        nombre, tipo_jornada: tipo,
        municipio_id: municipioId || null,
        destino_nombre: tipo === 'disponible' ? null : (destino || null),
        observaciones: null,
      },
    });
    cerrarModal();
    aviso('Guardado en el banco', 'ok', 'Listo');
    predeterminados = await api('/api/predeterminados');
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

async function modalPredeterminados() {
  predeterminados = await api('/api/predeterminados');
  abrirModal('Banco de predeterminados', `
    <p style="font-size:.87rem;color:var(--text-soft);margin:0 0 1rem">
      Combinaciones de jornada y destino que se repiten. Se aplican con un clic al
      adjudicar, y son los valores que acepta la plantilla de Excel.</p>
    ${predeterminados.length ? `<div class="tabla-env" style="border:0"><table>
      <thead><tr><th>Nombre</th><th>Jornada</th><th>Destino</th><th class="num">Usos</th><th></th></tr></thead>
      <tbody>${predeterminados.map(p => `
        <tr>
          <td><b>${esc(p.nombre)}</b></td>
          <td><span class="etq ${TIPOS_JORNADA[p.tipo_jornada]?.color || 'gris'}">${TIPOS_JORNADA[p.tipo_jornada]?.et || esc(p.tipo_jornada)}</span></td>
          <td>${esc(p.destino || '—')}<br><span style="font-size:.7rem;color:var(--muted)">${esc(p.municipio || '')}</span></td>
          <td class="num">${p.veces_usado}</td>
          <td>${sesion.rol === 'principal'
            ? `<button class="btn sec sm" onclick="quitarPredeterminado(${p.id})">Quitar</button>`
            : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="vacio">Todavía no hay predeterminados. Se crean al adjudicar un desplazamiento, con el botón <b>Guardar como predeterminado</b>.</div>'}`);
}

async function quitarPredeterminado(id) {
  try {
    await api('/api/predeterminados/' + id, { metodo: 'DELETE' });
    aviso('Quitado del banco', 'ok');
    modalPredeterminados();
  } catch (e) { aviso(e.message, 'mal'); }
}

async function verCambios(id) {
  const c = await api(`/api/itinerario/${id}/cambios`);
  const CAMPOS = {
    conductor_id: 'Conductor', municipio_id: 'Municipio', destino_id: 'Destino',
    tipo_jornada: 'Tipo de jornada', observaciones: 'Observaciones', estado: 'Estado',
  };
  abrirModal('Historial de cambios', c.length ? c.map(x => `
    <div style="border-left:3px solid var(--ambar);padding:.5rem .75rem;margin-bottom:.6rem;background:var(--surface-2);border-radius:0 8px 8px 0">
      <div style="font-weight:700;font-size:.85rem">${CAMPOS[x.campo] || esc(x.campo)}</div>
      <div style="font-size:.8rem;color:var(--text-soft);margin:.15rem 0">
        <s style="color:var(--muted)">${esc(x.valor_antes ?? 'vacío')}</s> → <b>${esc(x.valor_despues ?? 'vacío')}</b>
      </div>
      <div style="font-size:.72rem;color:var(--muted)">
        ${esc(x.nombre_usuario?.trim() || x.usuario || 'usuario')} · ${fechaHora(x.ts)}
      </div>
      ${x.motivo ? `<div style="font-size:.78rem;margin-top:.25rem;font-style:italic">"${esc(x.motivo)}"</div>` : ''}
    </div>`).join('') : '<div class="vacio">Sin modificaciones.</div>');
}

function modalCopiarSemana() {
  const hasta = nDias(itinDesde, itinDias - 1);
  abrirModal('Copiar programación', `
    <p style="font-size:.88rem;color:var(--text-soft);margin:0 0 1rem">
      Copia la programación del <b>${itinDesde}</b> al <b>${hasta}</b> hacia adelante.
      Los días que ya tengan programación se dejan como están.
    </p>
    <div class="campo"><label class="lb">Copiar a partir del</label>
      <input class="inp" type="date" id="cp-desde" value="${nDias(itinDesde, itinDias)}"></div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn" id="cp-btn" onclick="copiarSemana('${itinDesde}','${hasta}')">Copiar</button>`);
}

async function copiarSemana(desde, hasta) {
  const btn = $('#cp-btn'); btn.disabled = true; btn.textContent = 'Copiando...';
  try {
    const r = await api('/api/itinerario/copiar', {
      metodo: 'POST',
      cuerpo: { desde, hasta, destino_desde: $('#cp-desde').value },
    });
    cerrarModal();
    aviso(`${r.creados} copiada(s)${r.omitidos ? `, ${r.omitidos} omitida(s) por tener programación` : ''}`, 'ok', 'Listo');
    verItinerario();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo copiar');
    btn.disabled = false; btn.textContent = 'Copiar';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

let dashDesde = null, dashHasta = null;

const COLORES = ['#1e5aa8', '#0a7d57', '#a2620a', '#6d3aad', '#c22e24', '#0e7490', '#9a3412'];

function grafica(id, config) {
  const el = document.getElementById(id);
  if (!el || typeof Chart === 'undefined') return;
  graficas[id]?.destroy();
  Chart.defaults.font.family = "'Inter',system-ui,sans-serif";
  Chart.defaults.color = '#75828f';
  graficas[id] = new Chart(el, config);
}

/**
 * Enfoque del dashboard (D37): al escoger un conductor o un vehículo, TODO
 * pasa a hablar solo de él. El recorte lo hace el servidor, no la pantalla:
 * así los contadores de arriba son los de esa persona y no los de la flota
 * con una tabla recortada debajo.
 */
let dashConductor = '', dashVehiculo = '';

function enfocarDash(campo, valor) {
  if (campo === 'conductor') dashConductor = valor; else dashVehiculo = valor;
  verDashboard();
}

async function verDashboard() {
  if (!dashDesde) { dashDesde = hoy().slice(0, 8) + '01'; dashHasta = hoy(); }
  $('#main').innerHTML = '<div class="cargando">Calculando...</div>';
  let d;
  try {
    d = await api(`/api/dashboard?desde=${dashDesde}&hasta=${dashHasta}` +
      (dashConductor ? `&conductor_id=${dashConductor}` : '') +
      (dashVehiculo ? `&vehiculo_id=${dashVehiculo}` : ''));
  }
  catch (e) { return $('#main').innerHTML = `<div class="card"><div class="nota avi">${esc(e.message)}</div></div>`; }

  const t = d.totales || {};
  const conDatos = d.por_vehiculo.filter(v => v.dias_registrados > 0);
  // Con la flota entera, un conductor sin un solo día registrado solo añade
  // ruido a la gráfica; enfocado en uno, se muestra aunque esté en cero,
  // porque esa es justamente la respuesta.
  const condDatos = (d.por_conductor || []).filter(c =>
    dashConductor || c.dias_programados || c.dias_con_desplazamiento || c.trayectos);
  const cumplimiento = t.programados ? Math.round((t.ejecutados / t.programados) * 100) : 0;
  const totalPagar = d.por_vehiculo.reduce((s, v) => s + (v.valor_estimado || 0), 0);
  const enfocado = dashConductor || dashVehiculo;
  const nombreCond = dashConductor &&
    (d.por_conductor.find(c => String(c.id) === String(dashConductor))?.conductor || '').trim();
  const placaVeh = dashVehiculo &&
    (d.por_vehiculo.find(v => String(v.id) === String(dashVehiculo))?.placa || '');

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Dashboard</h1><p>Del ${dashDesde} al ${dashHasta}</p></div>
      <div style="display:flex;gap:.4rem;align-items:flex-end;flex-wrap:wrap">
        <div><label class="lb">Desde</label><input class="inp" type="date" id="d-desde" value="${dashDesde}" style="width:auto"></div>
        <div><label class="lb">Hasta</label><input class="inp" type="date" id="d-hasta" value="${dashHasta}" style="width:auto"></div>
        <button class="btn sm" onclick="dashDesde=$('#d-desde').value;dashHasta=$('#d-hasta').value;verDashboard()">Aplicar</button>
        <button class="btn sec sm" onclick="exportarDashboard()">Descargar</button>
      </div>
    </div>

    <div class="card filtros-tray" style="margin-bottom:.85rem">
      <div class="fila">
        <div><label class="lb">Conductor</label>
          <select class="inp" onchange="enfocarDash('conductor',this.value)">
            <option value="">Todos los conductores</option>
            ${(d.por_conductor || []).map(c => `<option value="${c.id}"
              ${String(dashConductor) === String(c.id) ? 'selected' : ''}
              >${esc((c.conductor || '').trim())}</option>`).join('')}
          </select></div>
        <div><label class="lb">Vehículo</label>
          <select class="inp" onchange="enfocarDash('vehiculo',this.value)">
            <option value="">Todos los vehículos</option>
            ${d.por_vehiculo.map(v => `<option value="${v.id}"
              ${String(dashVehiculo) === String(v.id) ? 'selected' : ''}
              >${esc(v.placa)}</option>`).join('')}
          </select></div>
        ${enfocado ? `<button class="btn sec sm" style="margin-bottom:.45rem"
          onclick="dashConductor='';dashVehiculo='';verDashboard()">Quitar el enfoque</button>` : ''}
      </div>
    </div>

    ${enfocado ? `<div class="nota" style="margin-bottom:.85rem;border-left:4px solid var(--azul)">
      Todo lo de abajo es <b>solo de ${esc([nombreCond, placaVeh].filter(Boolean).join(' con '))}</b>
      en este período: los contadores, las gráficas y las tablas.
    </div>` : ''}

    <div class="grid g4">
      <div class="kpi azul"><div class="et">Días pagables</div><div class="val">${num(t.pagables || 0)}</div>
        <div class="pie">lo que se liquida</div></div>
      <div class="kpi verde"><div class="et">Con desplazamiento</div><div class="val">${num(t.ejecutados || 0)}</div>
        <div class="pie">días con salida marcada</div></div>
      <div class="kpi"><div class="et">Cumplimiento</div><div class="val">${cumplimiento}%</div>
        <div class="pie">${num(t.ejecutados || 0)} de ${num(t.programados || 0)} programados</div></div>
      <div class="kpi ambar"><div class="et">Valor estimado</div><div class="val" style="font-size:1.3rem">${pesos(totalPagar)}</div>
        <div class="pie">días pagables × tarifa</div></div>
    </div>

    <div class="grid g4" style="margin-top:.85rem">
      <div class="kpi"><div class="et">Viajes</div><div class="val">${num(t.trayectos || 0)}</div></div>
      <div class="kpi"><div class="et">Horas</div><div class="val">${num(Math.round(t.horas || 0))}</div></div>
      <div class="kpi"><div class="et">Kilómetros</div><div class="val">${num(t.km || 0)}</div></div>
      <div class="kpi ${d.vencimientos.length ? 'rojo' : ''}"><div class="et">Vencimientos</div>
        <div class="val">${d.vencimientos.length}</div><div class="pie">próximos 30 días</div></div>
    </div>

    ${t.pagables > t.ejecutados ? `
      <div class="nota" style="margin-top:.85rem">
        Hay <b>${t.pagables - t.ejecutados} día(s) pagables sin desplazamiento</b>: son días en base
        marcados como disponibles, que se pagan igual. Por eso los dos contadores no coinciden.
      </div>` : ''}

    <div class="card" style="margin-top:.85rem">
      <h2>Qué vehículos están trabajando más</h2>
      <p style="color:var(--muted);font-size:.8rem;margin:.2rem 0 .85rem">
        Comparación entre lo que se programó y lo que el conductor marcó en terreno.</p>
      <div class="grafica-env"><canvas id="g-ranking"></canvas></div>
    </div>

    <div class="grid g2" style="margin-top:.85rem">
      <div class="card"><h3>Viajes por día</h3><div class="grafica-env"><canvas id="g-dias"></canvas></div></div>
      <div class="card"><h3>Destinos más visitados</h3><div class="grafica-env"><canvas id="g-destinos"></canvas></div></div>
    </div>

    <div class="grid g2" style="margin-top:.85rem">
      <div class="card"><h3>Viajes por municipio</h3><div class="grafica-env"><canvas id="g-municipios"></canvas></div></div>
      <div class="card"><h3>Novedades por tipo</h3>
        ${d.eventos.length ? '<div class="grafica-env"><canvas id="g-eventos"></canvas></div>'
          : '<div class="vacio">Sin novedades en el período.</div>'}</div>
    </div>

    <div class="card" style="margin-top:.85rem">
      <h2>Qué conductores están rodando más</h2>
      <p style="color:var(--muted);font-size:.8rem;margin:.2rem 0 .85rem">
        Los mismos días que la tabla de vehículos, contados por quien los condujo.</p>
      ${condDatos.length
        ? '<div class="grafica-env"><canvas id="g-conductores"></canvas></div>'
        : '<div class="vacio">Ningún conductor tiene días registrados en el período.</div>'}
    </div>

    ${condDatos.length ? `
    <div class="card" style="margin-top:.85rem">
      <h2>Detalle por conductor</h2>
      <p style="color:var(--muted);font-size:.8rem;margin:.2rem 0 0">
        <b>Calidad del registro</b> no mide al conductor como trabajador: mide cómo está
        usando la aplicación, y sirve para saber a quién reforzarle la capacitación.
        <b>Novedades</b> es actividad, no problema — quien más reporta suele ser el que
        mejor reporta.</p>
      <div class="tabla-env" style="margin-top:.75rem;border:0">
        <table>
          <thead>
            <tr class="grupo">
              <th></th>
              <th class="num" colspan="5">Operación</th>
              <th class="num sep" colspan="3">Calidad del registro</th>
              <th class="num sep">Novedades</th>
              <th class="num sep" colspan="2">Checklist</th>
            </tr>
            <tr>
              <th>Conductor</th>
              <th class="num">Programados</th><th class="num">Con despl.</th>
              <th class="num">Viajes</th><th class="num">Horas</th><th class="num">Km</th>
              <th class="num sep" title="Marcas que quedaron sin ubicación">Sin GPS</th>
              <th class="num" title="Marcas tomadas sin señal y enviadas después">Sin señal</th>
              <th class="num" title="Salidas que nunca se cerraron con una llegada">Abiertos</th>
              <th class="num sep">Reportadas</th>
              <th class="num sep">Diligenciados</th><th class="num">Completos</th>
            </tr>
          </thead>
          <tbody>${condDatos.map(c => `
            <tr>
              <td><b>${esc((c.conductor || '').trim() || 'Sin nombre')}</b></td>
              <td class="num">${num(c.dias_programados || 0)}</td>
              <td class="num"><b>${num(c.dias_con_desplazamiento || 0)}</b></td>
              <td class="num">${num(c.trayectos || 0)}</td>
              <td class="num">${num(Math.round(c.horas || 0))}</td>
              <td class="num">${num(c.km || 0)}</td>
              <td class="num sep">${c.sin_gps
                ? `<span class="etq ambar">${c.sin_gps}</span>` : '0'}</td>
              <td class="num">${num(c.sin_senal || 0)}</td>
              <td class="num">${c.abiertos
                ? `<span class="etq rojo">${c.abiertos}</span>` : '0'}</td>
              <td class="num sep">${num(c.novedades || 0)}</td>
              <td class="num sep">${num(c.checklists || 0)}</td>
              <td class="num">${c.checklists
                ? (c.checklists_completos === c.checklists
                    ? `<span class="etq verde">${c.checklists_completos}</span>`
                    : `<span class="etq ambar">${c.checklists_completos || 0}</span>`)
                : '—'}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="card" style="margin-top:.85rem">
      <h2>Detalle por vehículo</h2>
      <div class="tabla-env" style="margin-top:.75rem;border:0">
        <table>
          <thead><tr>
            <th>Vehículo</th><th>Propiedad</th>
            <th class="num">Programados</th><th class="num">Con despl.</th>
            <th class="num">Pagables</th><th class="num">Viajes</th>
            <th class="num">Horas</th><th class="num">Km</th><th class="num">Valor</th>
          </tr></thead>
          <tbody>${d.por_vehiculo.map(v => `
            <tr>
              <td class="placa">${esc(v.placa)}</td>
              <td><span class="etq ${v.propiedad === 'contratista' ? 'ambar' : 'gris'}">${esc(v.propiedad)}</span></td>
              <td class="num">${num(v.dias_programados || 0)}</td>
              <td class="num"><b>${num(v.dias_con_desplazamiento || 0)}</b></td>
              <td class="num">${num(v.dias_pagables || 0)}</td>
              <td class="num">${num(v.trayectos || 0)}</td>
              <td class="num">${num(Math.round(v.horas || 0))}</td>
              <td class="num">${num(v.km || 0)}</td>
              <td class="num">${v.valor_dia ? pesos(v.valor_estimado) : '<span style="color:var(--muted)">sin tarifa</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    ${d.vencimientos.length ? `
      <div class="card" style="margin-top:.85rem;border-left:4px solid var(--rojo)">
        <h2>Vencimientos próximos</h2>
        <div class="tabla-env" style="margin-top:.75rem;border:0"><table>
          <thead><tr><th>Titular</th><th>Documento</th><th>Vence</th><th class="num">Días</th></tr></thead>
          <tbody>${d.vencimientos.map(v => `
            <tr><td><b>${esc(v.titular)}</b></td><td>${esc(v.tipo)}</td><td>${esc(v.vencimiento)}</td>
              <td class="num"><span class="etq ${v.dias < 0 ? 'rojo' : 'ambar'}">${v.dias < 0 ? 'vencido' : v.dias + ' días'}</span></td></tr>`).join('')}
          </tbody></table></div>
      </div>` : ''}

    ${d.checklist.some(c => c.total > 0) ? `
      <div class="card" style="margin-top:.85rem">
        <h2>Cumplimiento del checklist</h2>
        <div class="tabla-env" style="margin-top:.75rem;border:0"><table>
          <thead><tr><th>Vehículo</th><th class="num">Checklists</th><th class="num">Completos</th><th class="num">Ítems faltantes</th></tr></thead>
          <tbody>${d.checklist.filter(c => c.total > 0).map(c => `
            <tr><td class="placa">${esc(c.placa)}</td><td class="num">${c.total}</td>
              <td class="num">${c.completos || 0}</td>
              <td class="num">${c.faltantes ? `<span class="etq rojo">${c.faltantes}</span>` : '<span class="etq verde">0</span>'}</td></tr>`).join('')}
          </tbody></table></div>
      </div>` : ''}

    ${d.origen_marcas.length ? `
      <div class="nota" style="margin-top:.85rem">
        <b>Origen de las marcas:</b>
        ${d.origen_marcas.map(o => `${o.n} ${({
          en_linea: 'en línea', offline_sincronizado: 'sincronizadas sin señal',
          digitado_por_coordinador: 'digitadas',
        })[o.origen] || o.origen}`).join(' · ')}
      </div>` : ''}
  `;

  // ── Gráficas ──
  //
  // El ranking de vehículos y el de conductores cuentan lo mismo, así que
  // llevan la misma codificación de color: si fueran distintas habría que
  // releer la leyenda al pasar de una a la otra.
  //
  // El azul pálido de «Programados» era #c3d2e6, que no pasaba el validador de
  // paletas: fuera de la banda de luminosidad, por debajo del mínimo de croma
  // —se lee como gris— y 1,5:1 de contraste contra el fondo. #4e96db pasa las
  // seis comprobaciones, incluida la separación para daltonismo.
  const COLOR_DIAS = ['#4e96db', '#1e5aa8', '#0a7d57'];

  const ranking = (id, etiquetas, filas) => grafica(id, {
    type: 'bar',
    data: {
      labels: etiquetas,
      datasets: [
        { label: 'Programados', data: filas.map(x => x.dias_programados || 0),
          backgroundColor: COLOR_DIAS[0], borderRadius: 4 },
        { label: 'Con desplazamiento', data: filas.map(x => x.dias_con_desplazamiento || 0),
          backgroundColor: COLOR_DIAS[1], borderRadius: 4 },
        { label: 'Pagables', data: filas.map(x => x.dias_pagables || 0),
          backgroundColor: COLOR_DIAS[2], borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#e9edf2' } }, x: { grid: { display: false } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } },
    },
  });

  ranking('g-ranking', conDatos.map(v => v.placa), conDatos);
  if (condDatos.length) {
    // Primer nombre y primer APELLIDO. El nombre completo no cabe bajo la
    // barra, y cortar por las dos primeras palabras daba «JEISON OMAR» y
    // «JEISON MANDO»: dos nombres de pila que no distinguen a nadie.
    const corto = (c) => [
      (c.nombres || '').trim().split(/\s+/)[0] || '',
      (c.apellidos || '').trim().split(/\s+/)[0] || '',
    ].filter(Boolean).join(' ') || (c.conductor || '').trim();
    ranking('g-conductores', condDatos.map(corto), condDatos);
  }

  grafica('g-dias', {
    type: 'line',
    data: {
      labels: d.por_dia.map(x => x.fecha.slice(5)),
      datasets: [{
        label: 'Viajes', data: d.por_dia.map(x => x.trayectos),
        borderColor: '#1e5aa8', backgroundColor: 'rgba(30,90,168,.10)',
        fill: true, tension: .3, pointRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#e9edf2' } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });

  const donut = (id, etiquetas, valores) => grafica(id, {
    type: 'doughnut',
    data: { labels: etiquetas, datasets: [{ data: valores, backgroundColor: COLORES, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 11, padding: 10, font: { size: 11 } } } },
    },
  });

  grafica('g-destinos', {
    type: 'bar',
    data: {
      labels: d.por_destino.map(x => x.destino || 'Sin destino'),
      datasets: [{ label: 'Veces', data: d.por_destino.map(x => x.veces), backgroundColor: '#6d3aad', borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#e9edf2' } }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });

  donut('g-municipios', d.por_municipio.map(x => x.municipio), d.por_municipio.map(x => x.trayectos));
  if (d.eventos.length) {
    const ET = Object.fromEntries(TIPOS_EVENTO);
    donut('g-eventos', d.eventos.map(x => ET[x.tipo] || x.tipo), d.eventos.map(x => x.n));
  }
}

/** Descarga el detalle por vehículo como CSV, legible en Excel. */
async function exportarDashboard() {
  const d = await api(`/api/dashboard?desde=${dashDesde}&hasta=${dashHasta}` +
    (dashConductor ? `&conductor_id=${dashConductor}` : '') +
    (dashVehiculo ? `&vehiculo_id=${dashVehiculo}` : ''));

  // Los dos detalles en un solo archivo, uno debajo del otro: es lo que se
  // pega en un informe, y con dos archivos siempre se pierde uno.
  const bloques = [
    [['DETALLE POR VEHICULO'],
     ['Placa', 'Propiedad', 'Contratista', 'Dias programados', 'Dias con desplazamiento',
      'Dias pagables', 'Viajes', 'Horas', 'Kilometros', 'Valor dia', 'Valor estimado'],
     ...d.por_vehiculo.map(v => [v.placa, v.propiedad, v.contratista || '',
       v.dias_programados || 0, v.dias_con_desplazamiento || 0, v.dias_pagables || 0,
       v.trayectos || 0, Math.round(v.horas || 0), v.km || 0,
       v.valor_dia || '', v.valor_estimado || 0])],
    [['DETALLE POR CONDUCTOR'],
     ['Conductor', 'Dias programados', 'Dias con desplazamiento', 'Dias pagables',
      'Viajes', 'Horas', 'Kilometros', 'Marcas sin GPS', 'Marcas sin senal',
      'Viajes abiertos', 'Novedades reportadas', 'Checklists', 'Checklists completos'],
     ...(d.por_conductor || []).map(c => [(c.conductor || '').trim(),
       c.dias_programados || 0, c.dias_con_desplazamiento || 0, c.dias_pagables || 0,
       c.trayectos || 0, Math.round(c.horas || 0), c.km || 0,
       c.sin_gps || 0, c.sin_senal || 0, c.abiertos || 0, c.novedades || 0,
       c.checklists || 0, c.checklists_completos || 0])],
  ];
  const csv = bloques
    .map(b => b.map(f => f.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n'))
    .join('\n\n');
  // BOM para que Excel reconozca los acentos
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `flota_${dashDesde}_a_${dashHasta}.csv`; a.click();
  URL.revokeObjectURL(url);
  aviso('Archivo descargado', 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTADOS Y ADMINISTRACIÓN
// ═══════════════════════════════════════════════════════════════════════════

let trayectosCargados = [];

/** Coordenadas con botón de copiar y enlace al mapa. */
function celdaGeo(lat, lon, precision, etiqueta) {
  if (lat == null || lon == null) {
    return '<span class="etq gris" title="La marca se registró sin ubicación">sin GPS</span>';
  }
  const txt = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const dudosa = precision != null && precision > 100;
  return `<div class="geo">
    <button class="geo-copiar" onclick="copiarGeo('${txt}',event)"
      title="Copiar coordenadas">${txt}</button>
    <div style="display:flex;gap:.35rem;align-items:center;margin-top:.15rem">
      <a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener"
        style="font-size:.68rem">ver en el mapa</a>
      ${precision != null ? `<span class="etq ${dudosa ? 'ambar' : 'gris'}"
        style="font-size:.6rem" title="${dudosa ? 'Lectura poco precisa' : 'Precisión del GPS'}"
        >±${Math.round(precision)} m</span>` : ''}
    </div>
  </div>`;
}

async function copiarGeo(texto, ev) {
  ev?.stopPropagation();
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // Sin permiso de portapapeles (o sin HTTPS): se copia por el camino viejo
    const ta = document.createElement('textarea');
    ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* nada más que hacer */ }
    ta.remove();
  }
  aviso(`Copiado: ${texto}`, 'ok');
}

// ── Selector de período, compartido ─────────────────────────────────────────
//
// Lo usan Viajes y Novedades. Las dos nacieron con una ventana fija —14 y 60
// días— y las dos son pantallas donde se revisa: con una ventana fija había
// que creerles en vez de poder auditarlas.

/**
 * Las fechas de un atajo. 'todo' no sale de aquí: hay que preguntarle al
 * servidor desde cuándo hay registros, y eso depende de la pantalla.
 */
function rangoAtajo(cual) {
  const h = hoy();
  if (cual === 'mes') return { desde: h.slice(0, 8) + '01', hasta: h };
  if (cual === 'mes-pasado') {
    const d = new Date(h + 'T12:00:00');
    d.setDate(1); d.setMonth(d.getMonth() - 1);
    const desde = d.toISOString().slice(0, 10);
    d.setMonth(d.getMonth() + 1); d.setDate(0);
    return { desde, hasta: d.toISOString().slice(0, 10) };
  }
  return { desde: nDias(h, -Number(cual) + 1), hasta: h };
}

/**
 * @param pref   prefijo de los id de los campos ('tr', 'ev'...)
 * @param desde  fecha inicial actual
 * @param hasta  fecha final actual
 * @param fnAtajo  nombre de la función que recibe el atajo
 * @param derecha  lo que va al final de la fila (botones de la pantalla)
 */
function barraPeriodo(pref, desde, hasta, fnAtajo, derecha = '') {
  return `<div class="fila">
    <div><label class="lb">Desde</label>
      <input class="inp" type="date" id="${pref}-desde" value="${desde}"></div>
    <div><label class="lb">Hasta</label>
      <input class="inp" type="date" id="${pref}-hasta" value="${hasta}"></div>
    <button class="btn sm" onclick="${fnAtajo}('aplicar')">Aplicar</button>
    <div class="chips">
      <button class="chip" onclick="${fnAtajo}(14)">14 días</button>
      <button class="chip" onclick="${fnAtajo}(30)">30 días</button>
      <button class="chip" onclick="${fnAtajo}('mes')">Este mes</button>
      <button class="chip" onclick="${fnAtajo}('mes-pasado')">Mes pasado</button>
      <button class="chip" onclick="${fnAtajo}('todo')">Toda la operación</button>
    </div>
    ${derecha}
  </div>`;
}

/** Lee los dos campos de fecha y comprueba que tengan sentido. */
function leerPeriodo(pref) {
  const d = $(`#${pref}-desde`).value, h = $(`#${pref}-hasta`).value;
  if (!d || !h) { aviso('Indique las dos fechas', 'mal', 'Falta una fecha'); return null; }
  if (h < d) { aviso('La fecha final es anterior a la inicial', 'mal', 'Fechas al revés'); return null; }
  return { desde: d, hasta: h };
}

// ── Viajes ───────────────────────────────────────────────────────────────────
//
// Esta pantalla es donde se VERIFICA: se contrasta lo que marcó el conductor
// con lo que se va a pagar. Por eso el período es libre —hasta toda la
// operación— y no una ventana fija de dos semanas, que obligaba a creerle a
// la pantalla en vez de poder revisarla.

let trayDesde = localStorage.getItem('flota_tray_desde') || '';
let trayHasta = localStorage.getItem('flota_tray_hasta') || '';
/** Filtros en memoria: se aplican sobre lo ya descargado, sin volver a pedir. */
let trayFiltro = { vehiculo: '', conductor: '', texto: '', sinGps: false };
/** Destapar los viajes anulados. Solo el administrador, y vuelve a pedirlos. */
let trayVerAnulados = false;
/** Tope que se le pidió al servidor; si vuelve lleno, se avisa. */
const TRAY_LIMITE = 5000;

async function verTrayectos() {
  if (!trayDesde || !trayHasta) { trayDesde = nDias(hoy(), -14); trayHasta = hoy(); }
  $('#main').innerHTML = '<div class="cargando">Cargando viajes...</div>';
  try {
    trayectosCargados = await api(
      `/api/trayectos?desde=${trayDesde}&hasta=${trayHasta}&limite=${TRAY_LIMITE}` +
      (trayVerAnulados ? '&anulados=1' : ''));
  } catch (e) {
    return $('#main').innerHTML = `<div class="card"><div class="nota avi">${esc(e.message)}</div></div>`;
  }
  pintarTrayectos();
}

/** Cambia el período y recarga. */
function periodoTrayectos(desde, hasta) {
  trayDesde = desde; trayHasta = hasta;
  localStorage.setItem('flota_tray_desde', desde);
  localStorage.setItem('flota_tray_hasta', hasta);
  verTrayectos();
}

/** Atajos de período. El del mes pasado es el que se usa para liquidar. */
function atajoTray(cual) {
  if (cual === 'todo') return todaLaOperacion();
  if (cual === 'aplicar') {
    const p = leerPeriodo('tr');
    return p && periodoTrayectos(p.desde, p.hasta);
  }
  const { desde, hasta } = rangoAtajo(cual);
  periodoTrayectos(desde, hasta);
}

/**
 * Desde el primer viaje registrado, no desde una fecha inventada: se le
 * pregunta al servidor cuál fue, para no pedir años vacíos.
 */
async function todaLaOperacion() {
  try {
    const r = await api('/api/trayectos/rango');
    periodoTrayectos(r.primera || nDias(hoy(), -365), r.ultima || hoy());
  } catch (e) {
    // Contra un Worker viejo esa ruta no existe. En vez de dejar el botón
    // muerto se pide un rango amplio: sale lo mismo, solo que la fecha de
    // inicio es inventada en lugar de ser la del primer viaje.
    if (!esFalloDeRed(e)) {
      periodoTrayectos('2026-01-01', hoy());
      return aviso('Se pidió desde enero: el servidor todavía no sabe decir ' +
        'desde cuándo hay viajes. Actualícelo para que la fecha sea exacta.', 'avi');
    }
    aviso(e.message, 'mal', 'No se pudo');
  }
}

/** Los viajes que pasan los filtros en memoria. */
function trayectosFiltrados() {
  const f = trayFiltro;
  const txt = f.texto.trim().toLowerCase();
  return trayectosCargados.filter(x => {
    if (f.vehiculo && String(x.vehiculo_id) !== f.vehiculo) return false;
    if (f.conductor && String(x.conductor_id) !== f.conductor) return false;
    if (f.sinGps && x.lat_salida != null && x.lat_llegada != null) return false;
    if (!txt) return true;
    return [x.consecutivo, x.placa, x.conductor, x.tripulantes, x.lugar_salida,
            x.lugar_llegada, x.municipio_salida, x.municipio_llegada, x.observaciones]
      .some(c => c && String(c).toLowerCase().includes(txt));
  });
}

function filtrarTrayectos(campo, valor) {
  trayFiltro[campo] = valor;
  // Solo se repinta la tabla: repintar la cabecera le quitaría el foco al
  // cuadro de búsqueda en cada letra.
  $('#tray-tabla').innerHTML = tablaTrayectos(trayectosFiltrados());
  $('#tray-cuenta').textContent = textoCuentaTray();
}

function textoCuentaTray() {
  const n = trayectosFiltrados().length, total = trayectosCargados.length;
  return `Del ${trayDesde} al ${trayHasta} · ${num(total)} registro(s)` +
         (n !== total ? ` · ${num(n)} tras los filtros` : '');
}

function pintarTrayectos() {
  const t = trayectosCargados;
  const sinGps = t.filter(x => x.lat_salida == null).length;
  const abiertos = t.filter(x => x.estado === 'en_curso').length;
  const tope = t.length >= TRAY_LIMITE;

  // Las listas de los filtros salen de lo descargado: solo se ofrece filtrar
  // por lo que de verdad aparece en el período.
  const vehs = [...new Map(t.map(x => [x.vehiculo_id, x.placa])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const conds = [...new Map(t.map(x => [x.conductor_id, (x.conductor || '').trim()])).entries()]
    .filter(c => c[1]).sort((a, b) => a[1].localeCompare(b[1]));

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Viajes</h1><p id="tray-cuenta">${textoCuentaTray()}</p></div>
      <button class="btn sec sm" onclick="sincronizarAhora()" id="btn-sincronizar">Actualizar</button>
    </div>

    <div class="card filtros-tray">
      ${barraPeriodo('tr', trayDesde, trayHasta, 'atajoTray',
        `<button class="btn sec sm" onclick="exportarTrayectos()"
           title="Lo que se está viendo, con todas las columnas">Descargar</button>`)}
      <div class="fila">
        <div><label class="lb">Vehículo</label>
          <select class="inp" onchange="filtrarTrayectos('vehiculo',this.value)">
            <option value="">Todos</option>
            ${vehs.map(([id, placa]) => `<option value="${id}" ${trayFiltro.vehiculo == id ? 'selected' : ''}
              >${esc(placa)}</option>`).join('')}
          </select></div>
        <div><label class="lb">Conductor</label>
          <select class="inp" onchange="filtrarTrayectos('conductor',this.value)">
            <option value="">Todos</option>
            ${conds.map(([id, n]) => `<option value="${id}" ${trayFiltro.conductor == id ? 'selected' : ''}
              >${esc(n)}</option>`).join('')}
          </select></div>
        <div style="flex:1;min-width:180px"><label class="lb">Buscar</label>
          <input class="inp" id="tr-buscar" value="${esc(trayFiltro.texto)}"
            placeholder="Consecutivo, lugar, tripulante, observación..."
            oninput="filtrarTrayectos('texto',this.value)"></div>
        <label class="marca-check">
          <input type="checkbox" ${trayFiltro.sinGps ? 'checked' : ''}
            onchange="filtrarTrayectos('sinGps',this.checked)"> Solo los que les falta GPS</label>
        ${sesion.rol === 'principal' ? `<label class="marca-check">
          <input type="checkbox" ${trayVerAnulados ? 'checked' : ''}
            onchange="trayVerAnulados=this.checked;verTrayectos()"> Ver también los anulados</label>` : ''}
      </div>
    </div>

    ${tope ? `<div class="nota avi" style="margin-bottom:.85rem">
      Se están mostrando los <b>${num(TRAY_LIMITE)} viajes más recientes</b> del período,
      que es el tope de una sola consulta. Hay más: acote las fechas para verlos todos.</div>` : ''}
    ${sinGps ? `<div class="nota avi" style="margin-bottom:.85rem">
      ${sinGps} viaje(s) quedaron sin ubicación: el conductor negó el permiso o no había señal
      de GPS al marcar.</div>` : ''}
    ${abiertos ? `<div class="nota avi" style="margin-bottom:.85rem">
      ${abiertos} viaje(s) siguen <b>en curso</b>: se marcó la salida y nunca la llegada.</div>` : ''}

    <div id="tray-tabla">${tablaTrayectos(trayectosFiltrados())}</div>`;
}

const ORIGEN_MARCA = {
  en_linea: ['verde', 'en línea'],
  offline_sincronizado: ['ambar', 'sin señal'],
  digitado_por_coordinador: ['gris', 'digitado'],
};

function tablaTrayectos(t) {
  if (!t.length) {
    return `<div class="card"><div class="vacio">
      ${trayectosCargados.length
        ? 'Ningún viaje coincide con los filtros.'
        : 'Sin viajes registrados en el período.'}</div></div>`;
  }
  return `<div class="tabla-env"><table>
    <thead><tr><th>Fecha</th><th>Viaje</th><th>Vehículo</th><th>Conductor</th><th>Tripulación</th>
      <th>Salida</th><th>Ubicación salida</th><th>Llegada</th><th>Ubicación llegada</th>
      <th class="num">Horas</th><th class="num">Km</th><th>Fotos</th><th>Marca</th></tr></thead>
    <tbody>${t.map(x => {
      const o = ORIGEN_MARCA[x.origen_salida] || ['gris', '—'];
      const km = (x.km_final && x.km_inicial) ? x.km_final - x.km_inicial : null;
      const fotos = (x.fotos || '').split(',').filter(Boolean);
      return `<tr class="${x.estado === 'anulado' ? 'fila-anulada' : ''}">
        <td>${esc(x.fecha_operacion)}</td>
        <td><button class="btn sec sm btn-viaje" onclick="verTrayecto(${x.id})"
          title="Ver todos los datos de este viaje">${esc(x.consecutivo || '#' + x.id)}</button>
          ${x.estado === 'en_curso' ? '<br><span class="etq ambar">en curso</span>' : ''}
          ${x.estado === 'anulado' ? '<br><span class="etq rojo">anulado</span>' : ''}</td>
        <td class="placa">${esc(x.placa)}</td>
        <td>${esc(x.conductor?.trim() || '—')}</td>
        <td style="max-width:190px">${x.tripulantes
          ? `<span style="font-size:.76rem">${esc(x.tripulantes)}</span>`
          : '<span style="color:var(--muted)">—</span>'}
          ${x.num_tripulantes ? `<br><span style="font-size:.68rem;color:var(--muted)">${x.num_tripulantes} a bordo</span>` : ''}</td>
        <td>${hora(x.ts_salida)}<br><span style="font-size:.72rem;color:var(--muted)">${esc(x.lugar_salida || '')}</span></td>
        <td>${celdaGeo(x.lat_salida, x.lon_salida, x.precision_salida)}</td>
        <td>${hora(x.ts_llegada)}<br><span style="font-size:.72rem;color:var(--muted)">${esc(x.lugar_llegada || '')}</span></td>
        <td>${celdaGeo(x.lat_llegada, x.lon_llegada, x.precision_llegada)}</td>
        <td class="num">${x.horas ?? '—'}</td>
        <td class="num">${num(km)}</td>
        <td>${fotos.length
          ? `<button class="btn sec sm btn-fotos" onclick="verFotos(${x.id},&#39;${esc(x.placa)}&#39;)">${fotos.length}</button>`
          : '<span class="etq gris">—</span>'}</td>
        <td><span class="etq ${o[0]}">${o[1]}</span></td>
      </tr>`; }).join('')}</tbody></table></div>`;
}

/**
 * Un viaje con TODOS sus campos.
 *
 * La tabla resume; aquí está lo que no cabe en una columna y es justo lo que
 * se mira cuando un dato no cuadra: los dos odómetros por separado, la hora
 * del servidor frente a la del celular, la precisión del GPS y quién registró
 * la marca.
 */
function verTrayecto(id) {
  const x = trayectosCargados.find(t => t.id === id);
  if (!x) return;
  const o = ORIGEN_MARCA[x.origen_salida] || ['gris', '—'];
  const ol = ORIGEN_MARCA[x.origen_llegada] || null;
  const km = (x.km_final && x.km_inicial) ? x.km_final - x.km_inicial : null;

  const hito = (t) => `
    <table class="ficha"><tbody>
      <tr><th>Municipio</th><td>${esc(t.mun || '—')}</td></tr>
      <tr><th>Lugar</th><td>${esc(t.lugar || '—')}</td></tr>
      <tr><th>Hora del servidor</th><td>${t.ts ? fechaHora(t.ts) : '—'}</td></tr>
      <tr><th>Hora del celular</th><td>${t.disp ? fechaHora(t.disp) : '—'}
        ${t.ts && t.disp && Math.abs(Date.parse(t.ts) - Date.parse(t.disp)) > 600000
          ? '<br><span class="etq ambar">difiere más de 10 minutos</span>' : ''}</td></tr>
      <tr><th>Odómetro</th><td>${t.km != null ? num(t.km) : '—'}</td></tr>
      <tr><th>Ubicación</th><td>${celdaGeo(t.lat, t.lon, t.prec)}</td></tr>
      <tr><th>Cómo se marcó</th><td>${t.org
        ? `<span class="etq ${t.org[0]}">${t.org[1]}</span>` : '—'}</td></tr>
    </tbody></table>`;

  abrirModal(`Viaje ${x.consecutivo || '#' + x.id}`, `
    <table class="ficha" style="margin-bottom:1rem"><tbody>
      <tr><th>Día de operación</th><td><b>${esc(x.fecha_operacion)}</b></td></tr>
      <tr><th>Estado</th><td>${x.estado === 'anulado'
        ? '<span class="etq rojo">Anulado — no cuenta para el pago</span>'
        : x.estado === 'cerrado'
        ? '<span class="etq verde">Cerrado</span>'
        : '<span class="etq ambar">En curso — sin llegada</span>'}</td></tr>
      ${x.estado === 'anulado' ? `
      <tr><th>Motivo de la anulación</th><td>${esc(x.motivo_anulacion || '—')}</td></tr>
      <tr><th>Anulado por</th><td>${esc(x.anulado_por_usuario || '—')}
        ${x.anulado_en ? ` <span style="color:var(--muted)">· ${fechaHora(x.anulado_en)}</span>` : ''}</td></tr>` : ''}
      <tr><th>Vehículo</th><td><span class="placa">${esc(x.placa)}</span></td></tr>
      <tr><th>Conductor</th><td>${esc(x.conductor?.trim() || '—')}</td></tr>
      <tr><th>Tripulantes</th><td>${esc(x.tripulantes || '—')}
        ${x.num_tripulantes ? ` <span style="color:var(--muted)">(${x.num_tripulantes} a bordo)</span>` : ''}</td></tr>
      <tr><th>Tipo de jornada</th><td>${esc(TIPOS_JORNADA[x.tipo_jornada]?.et || x.tipo_jornada || '—')}</td></tr>
      <tr><th>Kilómetros</th><td>${km != null
        ? `<b>${num(km)}</b> <span style="color:var(--muted)">(${num(x.km_inicial)} → ${num(x.km_final)})</span>`
        : '—'}</td></tr>
      <tr><th>Horas</th><td>${x.horas ?? '—'}</td></tr>
      <tr><th>Observaciones</th><td>${esc(x.observaciones || '—')}</td></tr>
      <tr><th>Registrado por</th><td>${esc(x.registrado_por || '—')}
        ${x.creado_en ? ` <span style="color:var(--muted)">· ${fechaHora(x.creado_en)}</span>` : ''}</td></tr>
    </tbody></table>

    <h3 class="ficha-tit">Salida</h3>
    ${hito({ mun: x.municipio_salida, lugar: x.lugar_salida, ts: x.ts_salida,
             disp: x.ts_salida_disp, km: x.km_inicial, lat: x.lat_salida,
             lon: x.lon_salida, prec: x.precision_salida, org: o })}

    <h3 class="ficha-tit">Llegada</h3>
    ${x.ts_llegada ? hito({ mun: x.municipio_llegada, lugar: x.lugar_llegada, ts: x.ts_llegada,
             disp: x.ts_llegada_disp, km: x.km_final, lat: x.lat_llegada,
             lon: x.lon_llegada, prec: x.precision_llegada, org: ol })
      : '<div class="nota avi">Este viaje no tiene llegada registrada.</div>'}`,
    `${(x.fotos || '').split(',').filter(Boolean).length
      ? `<button class="btn sec" onclick="verFotos(${x.id},'${esc(x.placa)}')">Ver fotografías</button>` : ''}
     ${sesion.rol === 'principal' ? (x.estado === 'anulado'
       ? `<button class="btn sec" onclick="restaurarTrayecto(${x.id})">Deshacer la anulación</button>`
       : `<button class="btn rojo" onclick="modalQuitarTrayecto(${x.id})">Quitar este viaje</button>`) : ''}
     <button class="btn sec" onclick="cerrarModal()">Cerrar</button>`);
}

/**
 * Quitar un viaje. Solo el administrador (D35).
 *
 * Un viaje es el soporte de un día de operación: quitarlo cambia lo que se le
 * paga a un contratista. Por eso se ofrecen dos cosas distintas, igual que en
 * el itinerario, y la de por omisión es la reversible: ANULAR deja el registro
 * y su motivo a la vista de quien revise la cuenta; BORRAR solo es para lo que
 * se registró por error y no debe dejar rastro.
 */
function modalQuitarTrayecto(id) {
  const x = trayectosCargados.find(t => t.id === id);
  if (!x) return;
  const km = (x.km_final && x.km_inicial) ? x.km_final - x.km_inicial : null;

  abrirModal('Quitar el viaje', `
    <div class="nota avi" style="margin-bottom:1rem">
      <b>${esc(x.consecutivo || '#' + x.id)}</b> · ${esc(x.placa)} ·
      ${esc(x.fecha_operacion)}${km != null ? ` · ${num(km)} km` : ''}<br>
      Si era el único viaje de ese día, <b>el día deja de contarse como
      ejecutado</b> y deja de ser pagable.
    </div>
    <div class="campo"><label class="lb">Por qué se quita <span class="req">*</span></label>
      <textarea class="inp" id="qt-motivo" rows="2"
        placeholder="Ej: lo registró el conductor equivocado; se duplicó al sincronizar"></textarea>
      <p class="ayuda">Queda registrado con su nombre. Es lo que explica después
        el cambio en la liquidación.</p></div>
    <div class="campo">
      <label style="display:flex;gap:.5rem;align-items:flex-start;font-size:.86rem;cursor:pointer">
        <input type="checkbox" id="qt-definitivo" style="margin-top:.2rem">
        <span><b>Borrar definitivamente</b><br>
          <span style="color:var(--muted);font-size:.8rem">Sin esta casilla queda
          <b>anulado</b>: no cuenta en ninguna parte, pero el viaje, sus fotografías
          y el motivo se pueden consultar, y se puede deshacer. Con ella se elimina
          de verdad, con sus fotografías y su checklist, y no hay vuelta atrás.
          Las novedades que se hubieran reportado en ese viaje no se borran.</span>
        </span></label>
    </div>`,
    `<button class="btn sec" onclick="verTrayecto(${id})">Volver</button>
     <button class="btn rojo" id="qt-btn" onclick="confirmarQuitarTrayecto(${id})">Confirmar</button>`);
}

async function confirmarQuitarTrayecto(id) {
  const motivo = $('#qt-motivo').value.trim();
  if (motivo.length < 5) {
    return aviso('Escriba por qué se quita', 'mal', 'Falta el motivo');
  }
  const definitivo = $('#qt-definitivo').checked;
  const btn = $('#qt-btn'); btn.disabled = true; btn.textContent = 'Quitando...';
  try {
    const r = await api(`/api/trayectos/${id}${definitivo ? '?definitivo=1' : ''}`,
      { metodo: 'DELETE', cuerpo: { motivo } });
    cerrarModal();
    // Se dice cómo quedó el día: es la consecuencia que importa.
    aviso(`${definitivo ? 'Viaje borrado' : 'Viaje anulado'}. El ${r.fecha} ` +
      (r.dia?.dia_pagable ? 'sigue siendo pagable (hay otro viaje).' : 'ya no cuenta como pagable.'),
      'ok', 'Listo');
    verTrayectos();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo quitar');
    btn.disabled = false; btn.textContent = 'Confirmar';
  }
}

async function restaurarTrayecto(id) {
  try {
    await api(`/api/trayectos/${id}/restaurar`, { metodo: 'POST', cuerpo: {} });
    cerrarModal();
    aviso('El viaje vuelve a contar', 'ok', 'Listo');
    verTrayectos();
  } catch (e) { aviso(e.message, 'mal', 'No se pudo deshacer'); }
}

/** Lo que se está viendo, con TODAS las columnas, para revisarlo en Excel. */
function exportarTrayectos() {
  const t = trayectosFiltrados();
  if (!t.length) return aviso('No hay nada que descargar', 'avi');
  const cab = ['Consecutivo', 'Fecha operacion', 'Estado', 'Placa', 'Conductor',
    'Num tripulantes', 'Tripulantes', 'Tipo jornada',
    'Municipio salida', 'Lugar salida', 'Hora salida (servidor)', 'Hora salida (celular)',
    'Lat salida', 'Lon salida', 'Precision salida (m)', 'Origen salida', 'Km inicial',
    'Municipio llegada', 'Lugar llegada', 'Hora llegada (servidor)', 'Hora llegada (celular)',
    'Lat llegada', 'Lon llegada', 'Precision llegada (m)', 'Origen llegada', 'Km final',
    'Km recorridos', 'Horas', 'Fotos', 'Observaciones', 'Registrado por', 'Creado en'];
  const filas = t.map(x => [
    x.consecutivo || '', x.fecha_operacion, x.estado, x.placa, (x.conductor || '').trim(),
    x.num_tripulantes ?? '', x.tripulantes || '', x.tipo_jornada || '',
    x.municipio_salida || '', x.lugar_salida || '', x.ts_salida || '', x.ts_salida_disp || '',
    x.lat_salida ?? '', x.lon_salida ?? '', x.precision_salida ?? '', x.origen_salida || '',
    x.km_inicial ?? '',
    x.municipio_llegada || '', x.lugar_llegada || '', x.ts_llegada || '', x.ts_llegada_disp || '',
    x.lat_llegada ?? '', x.lon_llegada ?? '', x.precision_llegada ?? '', x.origen_llegada || '',
    x.km_final ?? '',
    (x.km_final && x.km_inicial) ? x.km_final - x.km_inicial : '',
    x.horas ?? '', (x.fotos || '').split(',').filter(Boolean).length,
    x.observaciones || '', x.registrado_por || '', x.creado_en || '',
  ]);
  const csv = [cab, ...filas]
    .map(f => f.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
  // BOM para que Excel reconozca los acentos
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `viajes_${trayDesde}_a_${trayHasta}.csv`; a.click();
  URL.revokeObjectURL(url);
  aviso(`${t.length} viaje(s) descargados`, 'ok');
}

async function verFotos(id, placa) {
  abrirModal(`Fotografías · ${placa}`, '<div class="cargando">Cargando...</div>');
  try {
    const fotos = await api(`/api/trayectos/${id}/fotos`);
    $('#modal-cpo').innerHTML = fotos.length ? fotos.map(f => `
      <div style="margin-bottom:1rem">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;margin-bottom:.35rem">
          <b style="text-transform:capitalize">${esc(f.momento)}</b>
          <span style="font-size:.72rem;color:var(--muted)">${fechaHora(f.ts)} · ${Math.round((f.bytes || 0) / 1024)} KB</span>
        </div>
        <img src="data:${f.mime};base64,${f.datos}" style="width:100%;border-radius:var(--r);border:1px solid var(--border)">
        ${f.lat != null ? `<div style="margin-top:.35rem">${celdaGeo(f.lat, f.lon, null)}</div>` : ''}
      </div>`).join('') : '<div class="vacio">Este viaje no tiene fotografías.</div>';
  } catch (e) {
    $('#modal-cpo').innerHTML = `<div class="nota avi">${esc(e.message)}</div>`;
  }
}

// ── Novedades ────────────────────────────────────────────────────────────────
//
// Mismo tratamiento que Viajes y por la misma razón: nació con una ventana
// fija de 60 días y es una pantalla donde se revisa.

let evDesde = localStorage.getItem('flota_ev_desde') || '';
let evHasta = localStorage.getItem('flota_ev_hasta') || '';
let eventosCargados = [];
let evFiltro = { tipo: '', abiertas: false };
const EV_LIMITE = 2000;

const GRAV_EV = { baja: 'gris', media: 'azul', alta: 'ambar', critica: 'rojo' };

async function verEventos() {
  if (!evDesde || !evHasta) { evDesde = nDias(hoy(), -59); evHasta = hoy(); }
  $('#main').innerHTML = '<div class="cargando">Cargando novedades...</div>';
  try {
    eventosCargados = await api(
      `/api/eventos?desde=${evDesde}&hasta=${evHasta}&limite=${EV_LIMITE}`);
  } catch (e) {
    return $('#main').innerHTML = `<div class="card"><div class="nota avi">${esc(e.message)}</div></div>`;
  }
  pintarEventos();
}

function periodoEventos(desde, hasta) {
  evDesde = desde; evHasta = hasta;
  localStorage.setItem('flota_ev_desde', desde);
  localStorage.setItem('flota_ev_hasta', hasta);
  verEventos();
}

function atajoEv(cual) {
  if (cual === 'aplicar') {
    const p = leerPeriodo('ev');
    return p && periodoEventos(p.desde, p.hasta);
  }
  if (cual === 'todo') return todasLasNovedades();
  const { desde, hasta } = rangoAtajo(cual);
  periodoEventos(desde, hasta);
}

/** Desde la primera novedad registrada, no desde una fecha inventada. */
async function todasLasNovedades() {
  try {
    const r = await api('/api/eventos/rango');
    periodoEventos(r.primera || nDias(hoy(), -365), r.ultima || hoy());
  } catch (e) {
    // Contra un Worker viejo esa ruta no existe: se pide un rango amplio en
    // vez de dejar el botón muerto.
    if (!esFalloDeRed(e)) {
      periodoEventos('2026-01-01', hoy());
      return aviso('Se pidió desde enero: el servidor todavía no sabe decir ' +
        'desde cuándo hay novedades. Actualícelo para que la fecha sea exacta.', 'avi');
    }
    aviso(e.message, 'mal', 'No se pudo');
  }
}

function eventosFiltrados() {
  return eventosCargados.filter(e =>
    (!evFiltro.tipo || e.tipo === evFiltro.tipo) &&
    (!evFiltro.abiertas || e.estado !== 'cerrado'));
}

function filtrarEventos(campo, valor) {
  evFiltro[campo] = valor;
  $('#ev-lista').innerHTML = listaEventos(eventosFiltrados());
  $('#ev-cuenta').textContent = textoCuentaEv();
}

function textoCuentaEv() {
  const n = eventosFiltrados().length, total = eventosCargados.length;
  return `Del ${evDesde} al ${evHasta} · ${num(total)} registro(s)` +
         (n !== total ? ` · ${num(n)} tras los filtros` : '');
}

function pintarEventos() {
  const ET = Object.fromEntries(TIPOS_EVENTO);
  const abiertas = eventosCargados.filter(e => e.estado !== 'cerrado').length;
  const tope = eventosCargados.length >= EV_LIMITE;
  // Solo se ofrecen los tipos que de verdad aparecen en el período.
  const tipos = [...new Set(eventosCargados.map(e => e.tipo))]
    .sort((a, b) => (ET[a] || a).localeCompare(ET[b] || b));

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Novedades</h1><p id="ev-cuenta">${textoCuentaEv()}</p></div>
      <button class="btn ambar" onclick="modalEvento()">Reportar novedad</button>
    </div>

    <div class="card filtros-tray">
      ${barraPeriodo('ev', evDesde, evHasta, 'atajoEv')}
      <div class="fila">
        <div><label class="lb">Tipo</label>
          <select class="inp" onchange="filtrarEventos('tipo',this.value)">
            <option value="">Todos</option>
            ${tipos.map(t => `<option value="${t}" ${evFiltro.tipo === t ? 'selected' : ''}
              >${esc(ET[t] || t)}</option>`).join('')}
          </select></div>
        <label class="marca-check">
          <input type="checkbox" ${evFiltro.abiertas ? 'checked' : ''}
            onchange="filtrarEventos('abiertas',this.checked)"> Solo las abiertas</label>
        ${abiertas ? `<span style="font-size:.78rem;color:var(--ambar);font-weight:700;
          padding-bottom:.45rem">${abiertas} sin cerrar</span>` : ''}
      </div>
    </div>

    ${tope ? `<div class="nota avi" style="margin-bottom:.85rem">
      Se están mostrando las <b>${num(EV_LIMITE)} novedades más recientes</b> del período.
      Hay más: acote las fechas para verlas todas.</div>` : ''}

    <div id="ev-lista">${listaEventos(eventosFiltrados())}</div>`;
}

function listaEventos(ev) {
  const ET = Object.fromEntries(TIPOS_EVENTO);
  const puede = sesion.rol !== 'conductor';
  if (!ev.length) {
    return `<div class="card"><div class="vacio">${eventosCargados.length
      ? 'Ninguna novedad coincide con los filtros.'
      : 'Sin novedades reportadas en el período.'}</div></div>`;
  }
  return ev.map(e => `
    <div class="card" style="border-left:4px solid var(--${GRAV_EV[e.gravedad] === 'gris' ? 'muted' : GRAV_EV[e.gravedad]})">
      <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:220px">
          <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
            <b>${esc(ET[e.tipo] || e.tipo)}</b>
            <span class="etq ${GRAV_EV[e.gravedad]}">${esc(e.gravedad)}</span>
            ${e.estado === 'cerrado' ? '<span class="etq verde">Cerrada</span>' : '<span class="etq ambar">Abierta</span>'}
          </div>
          <p style="margin:.4rem 0 .2rem;font-size:.88rem">${esc(e.descripcion)}</p>
          ${e.acciones ? `<p style="margin:.2rem 0;font-size:.82rem;color:var(--text-soft)"><b>Acciones:</b> ${esc(e.acciones)}</p>` : ''}
          <div style="font-size:.74rem;color:var(--muted);margin-top:.3rem">
            ${fechaHora(e.ts_evento)}
            ${e.placa ? ' · ' + esc(e.placa) : ''}
            ${e.municipio ? ' · ' + esc(e.municipio) : ''}
            ${e.lugar ? ' · ' + esc(e.lugar) : ''}
            ${e.persona ? ' · ' + esc(e.persona.trim()) : ''}
          </div>
        </div>
        ${puede && e.estado !== 'cerrado'
          ? `<button class="btn sec sm" onclick="cerrarEvento(${e.id})">Marcar cerrada</button>` : ''}
      </div>
    </div>`).join('');
}

async function cerrarEvento(id) {
  try {
    await api('/api/eventos/' + id, { metodo: 'PUT', cuerpo: { estado: 'cerrado' } });
    aviso('Novedad cerrada', 'ok'); verEventos();
  } catch (e) { aviso(e.message, 'mal'); }
}

// ── Vehículos ────────────────────────────────────────────────────────────────
// ── Días fuera de servicio (D33) ─────────────────────────────────────────────
//
// Responde a una pregunta que hasta ahora no tenía dónde contestarse: qué días
// estuvo parado cada vehículo y por qué. `vehiculos.estado` dice cómo está HOY
// y no desde cuándo, así que no sirve para liquidar.
//
// Un día fuera de servicio deja de ser pagable. Eso pesa sobre todo en los días
// DISPONIBLE, que se pagan sin que el conductor marque nada: sin esto, un
// vehículo en el taller seguiría cobrando por estar «en base».

/** Períodos del período visible del itinerario: fecha|vehiculo -> período. */
let fsPorDia = new Map();

/** Marca los días que cubre cada período, para pintarlos en la matriz. */
function indexarFS(periodos, dias) {
  fsPorDia = new Map();
  for (const p of periodos || []) {
    for (const f of dias) {
      if (f >= p.fecha_inicio && (!p.fecha_fin || f <= p.fecha_fin)) {
        fsPorDia.set(`${f}|${p.vehiculo_id}`, p);
      }
    }
  }
}

const fsDe = (fecha, vehiculoId) => fsPorDia.get(`${fecha}|${vehiculoId}`);

/**
 * El conductor declara que su vehículo quedó averiado.
 *
 * Acotado a propósito, y el servidor lo impone además: solo el vehículo que
 * tiene asignado hoy, desde hoy y sin fecha de regreso. Desde la vía no se sabe
 * nada más — se varó, y no sabe cuándo vuelve. Quien cierra el período es
 * Coordinación.
 *
 * No entra en la cola sin señal, igual que las novedades: esto cambia la
 * liquidación de un tercero y no debe quedar dependiendo de que el teléfono
 * sincronice días después. Si no hay señal se dice, y el conductor reporta por
 * radio o por teléfono.
 */
function modalAveriaConductor() {
  fotoTomada = null;
  const placa = diaActual?.itinerario?.placa || diaActual?.trayecto_abierto?.placa || '';
  abrirModal('El vehículo quedó averiado', `
    <div class="nota avi" style="margin-bottom:1rem">
      Esto deja el vehículo <b>${esc(placa)}</b> registrado como fuera de servicio
      <b>desde hoy</b>. Coordinación lo verá de inmediato y cerrará el registro
      cuando el vehículo vuelva a operar.
    </div>
    <div class="campo"><label class="lb">Qué pasó <span class="req">*</span></label>
      <select class="inp" id="av-causa">
        ${['averia', 'accidente', 'otro'].map(c =>
          `<option value="${c}">${CAUSAS_FS[c].et}</option>`).join('')}
      </select></div>
    <div class="campo"><label class="lb">Describa el daño <span class="req">*</span></label>
      <textarea class="inp" id="av-desc" rows="3"
        placeholder="Ej: se partió la correa saliendo de Ábrego; quedó en la vía"></textarea></div>
    <div class="campo"><label class="lb">Kilometraje, si lo tiene a la vista</label>
      <input class="inp" type="number" inputmode="numeric" id="av-km"></div>
    <div class="campo"><label class="lb">Fotografía</label>
      <input type="file" id="av-foto" accept="image/*" capture="environment"
        style="display:none" onchange="tomarFoto(this,'av')">
      <button type="button" class="btn sec bloque" id="av-foto-btn"
        onclick="$('#av-foto').click()" style="padding:.8rem">Tomar fotografía</button>
      <div id="av-foto-vista" style="display:none;margin-top:.5rem">
        <img id="av-foto-img" style="width:100%;border-radius:var(--r);border:1px solid var(--border)">
        <p style="font-size:.72rem;color:var(--muted);margin:.3rem 0 0" id="av-foto-peso"></p>
      </div>
      <p style="font-size:.72rem;color:var(--muted);margin:.35rem 0 0">
        Aquí la foto es opcional y se toma con la cámara normal: no es un soporte
        de pago, es para que en Coordinación vean el daño.</p>
    </div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn rojo" id="av-btn" onclick="guardarAveriaConductor()">Reportar</button>`);
}

async function guardarAveriaConductor() {
  const desc = $('#av-desc').value.trim();
  if (!desc) return aviso('Describa el daño', 'mal', 'Falta la descripción');
  const btn = $('#av-btn'); btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    await api('/api/fuera-servicio', {
      metodo: 'POST',
      cuerpo: {
        vehiculo_id: diaActual.vehiculo_id,
        causa: $('#av-causa').value,
        descripcion: desc,
        km_evento: $('#av-km').value ? Number($('#av-km').value) : undefined,
        foto: fotoTomada || undefined,
      },
    });
    fotoTomada = null;
    cerrarModal();
    aviso('Quedó registrado. Coordinación ya lo ve.', 'ok', 'Reportado');
    verHoy();
  } catch (e) {
    aviso(esFalloDeRed(e)
      ? 'Sin señal. Esto no se guarda en el celular porque afecta el pago: ' +
        'repórtelo por radio o por teléfono y vuelva a intentarlo con señal.'
      : e.message, 'mal', 'No se pudo reportar');
    btn.disabled = false; btn.textContent = 'Reportar';
  }
}

// ── Coordinación: el historial de cada vehículo ─────────────────────────────

let fsDelVehiculo = [];

/** Los períodos fuera de servicio de un vehículo, con qué registrar uno nuevo. */
async function modalFueraServicio(vehiculoId) {
  const v = vehiculos.find(x => x.id === vehiculoId);
  abrirModal(`Fuera de servicio · ${v?.placa || ''}`,
    '<div class="cargando">Cargando...</div>', '');
  try {
    fsDelVehiculo = await api('/api/fuera-servicio?vehiculo_id=' + vehiculoId);
  } catch (e) {
    return abrirModal(`Fuera de servicio · ${v?.placa || ''}`,
      `<div class="nota avi">${esc(e.message)}</div>`);
  }
  pintarFueraServicio(vehiculoId);
}

function pintarFueraServicio(vehiculoId) {
  const v = vehiculos.find(x => x.id === vehiculoId);
  const abierto = fsDelVehiculo.find(p => !p.fecha_fin);
  const admin = sesion.rol === 'principal';

  abrirModal(`Fuera de servicio · ${v?.placa || ''}`, `
    ${abierto ? `<div class="nota avi" style="margin-bottom:1rem">
      <b>Sigue fuera de servicio</b> desde el ${esc(abierto.fecha_inicio)}
      (${esc(causaEt(abierto.causa))}). Ciérrelo cuando vuelva a operar: mientras
      esté abierto, cada día que pasa deja de ser pagable.
    </div>` : ''}

    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.6rem">
      <b style="font-size:.85rem">${fsDelVehiculo.length} período(s) registrado(s)</b>
      <button class="btn sm" onclick="modalPeriodoFS(${vehiculoId})">Registrar período</button>
    </div>

    ${fsDelVehiculo.length ? `<div class="tabla-env"><table>
      <thead><tr><th>Desde</th><th>Hasta</th><th class="num">Días</th><th>Causa</th>
        <th>Detalle</th><th></th></tr></thead>
      <tbody>${fsDelVehiculo.map(p => {
        const cau = CAUSAS_FS[p.causa] || CAUSAS_FS.otro;
        return `<tr>
          <td>${esc(p.fecha_inicio)}</td>
          <td>${p.fecha_fin ? esc(p.fecha_fin)
            : '<span class="etq rojo">sigue parado</span>'}</td>
          <td class="num">${diasEntre(p.fecha_inicio, p.fecha_fin)}</td>
          <td><span class="etq ${cau.color}">${cau.et}</span></td>
          <td style="font-size:.78rem">
            ${p.descripcion ? esc(p.descripcion) + '<br>' : ''}
            ${p.taller ? '<span style="color:var(--muted)">Taller: ' + esc(p.taller) + '</span><br>' : ''}
            <span style="color:var(--muted);font-size:.72rem">
              ${p.rol_registro === 'conductor'
                ? 'Reportado por el conductor' : 'Registrado por Coordinación'}
              ${p.registrado_por_nombre ? '· ' + esc(p.registrado_por_nombre.trim()) : ''}</span>
            ${p.tiene_foto ? `<br><button class="btn sec sm" style="margin-top:.25rem"
              onclick="verFotoFS(${p.id})">Ver fotografía</button>` : ''}
          </td>
          <td style="white-space:nowrap">
            <button class="btn sec sm" onclick="modalPeriodoFS(${vehiculoId},${p.id})">Editar</button>
            ${admin ? `<button class="btn sec sm" onclick="borrarPeriodoFS(${vehiculoId},${p.id})"
              title="Borrar: úselo solo si se registró por error">Borrar</button>` : ''}
          </td>
        </tr>`; }).join('')}</tbody></table></div>`
      : '<div class="vacio"><p>Este vehículo no tiene días fuera de servicio registrados.</p></div>'}`,
    '<button class="btn sec" onclick="cerrarModal()">Cerrar</button>');
}

/** Días de un período; uno abierto se cuenta hasta hoy, que es lo que lleva. */
function diasEntre(desde, hasta) {
  const fin = hasta || hoy();
  if (fin < desde) return 0;
  return Math.round((Date.parse(fin) - Date.parse(desde)) / 86400000) + 1;
}

async function verFotoFS(id) {
  try {
    const f = await api(`/api/fuera-servicio/${id}/foto`);
    abrirModal('Fotografía del daño',
      `<img src="data:${f.mime};base64,${f.datos}"
            style="width:100%;border-radius:var(--r)">`,
      `<button class="btn sec" onclick="cerrarModal()">Cerrar</button>`);
  } catch (e) { aviso(e.message, 'mal', 'No se pudo cargar'); }
}

/** Alta o edición de un período. */
function modalPeriodoFS(vehiculoId, id) {
  const p = id ? fsDelVehiculo.find(x => x.id === id) : null;
  const v = vehiculos.find(x => x.id === vehiculoId);

  abrirModal(p ? 'Modificar período' : 'Registrar días fuera de servicio', `
    <div class="nota" style="margin-bottom:1rem">
      <b>${esc(v?.placa || '')}</b> · los días de este rango dejan de contarse como
      pagables${v?.propiedad === 'contratista' ? ', que es lo que sustenta el descuento al contratista' : ''}.
    </div>
    <div class="campo"><label class="lb">Causa <span class="req">*</span></label>
      <select class="inp" id="fs-causa">
        ${Object.entries(CAUSAS_FS).map(([k, c]) =>
          `<option value="${k}" ${p && p.causa === k ? 'selected' : ''}>${c.et}</option>`).join('')}
      </select></div>
    <div class="g2" style="display:grid;gap:.6rem">
      <div class="campo" style="margin:0"><label class="lb">Desde <span class="req">*</span></label>
        <input type="date" class="inp" id="fs-desde" value="${esc(p?.fecha_inicio || hoy())}"></div>
      <div class="campo" style="margin:0"><label class="lb">Hasta</label>
        <input type="date" class="inp" id="fs-hasta" value="${esc(p?.fecha_fin || '')}">
        <p class="ayuda">Déjelo vacío mientras siga parado.</p></div>
    </div>
    <div class="campo"><label class="lb">Qué pasó</label>
      <textarea class="inp" id="fs-desc" rows="2">${esc(p?.descripcion || '')}</textarea></div>
    <div class="g2" style="display:grid;gap:.6rem">
      <div class="campo" style="margin:0"><label class="lb">Taller</label>
        <input class="inp" id="fs-taller" value="${esc(p?.taller || '')}"></div>
      <div class="campo" style="margin:0"><label class="lb">Kilometraje</label>
        <input class="inp" type="number" id="fs-km" value="${p?.km_evento ?? ''}"></div>
    </div>
    ${p && !p.fecha_fin ? `<div class="campo"><label class="lb">Motivo del cierre</label>
      <input class="inp" id="fs-motivo" placeholder="Por qué vuelve a operar (queda registrado)">
      </div>` : ''}`,
    `<button class="btn sec" onclick="modalFueraServicio(${vehiculoId})">Volver</button>
     <button class="btn" id="fs-btn"
       onclick="guardarPeriodoFS(${vehiculoId},${id || 'null'})">Guardar</button>`);
}

async function guardarPeriodoFS(vehiculoId, id) {
  const desde = $('#fs-desde').value, hasta = $('#fs-hasta').value || null;
  if (!desde) return aviso('Indique desde qué día', 'mal', 'Falta la fecha');
  if (hasta && hasta < desde) {
    return aviso('La fecha de fin es anterior a la de inicio', 'mal', 'Fechas al revés');
  }
  const btn = $('#fs-btn'); btn.disabled = true; btn.textContent = 'Guardando...';
  const cuerpo = {
    vehiculo_id: vehiculoId,
    causa: $('#fs-causa').value,
    fecha_inicio: desde,
    fecha_fin: hasta,
    descripcion: $('#fs-desc').value.trim() || null,
    taller: $('#fs-taller').value.trim() || null,
    km_evento: $('#fs-km').value ? Number($('#fs-km').value) : null,
    motivo_cierre: $('#fs-motivo')?.value.trim() || undefined,
  };
  try {
    const r = id
      ? await api('/api/fuera-servicio/' + id, { metodo: 'PUT', cuerpo })
      : await api('/api/fuera-servicio', { metodo: 'POST', cuerpo });
    aviso(id ? 'Período actualizado' : 'Días registrados', 'ok', 'Listo');

    // Lo que hay que decidir a continuación: los días que ya estaban
    // programados dentro del rango. No se cancela nada por cuenta propia.
    if (!id && r.programados?.length) {
      return modalProgramadosFS(vehiculoId, r.programados);
    }
    if (vistaActual === 'vehiculos') await verVehiculos();
    if (vistaActual === 'itinerario') return verItinerario();
    modalFueraServicio(vehiculoId);
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

/**
 * Qué hacer con lo que ya estaba programado dentro del rango.
 *
 * Se ofrece cancelarlo, no se hace solo: puede haber un motivo para dejarlo —
 * un relevo con otro vehículo que todavía no se ha adjudicado, por ejemplo. Un
 * día con viajes ya registrados no se toca, y se dice cuál.
 */
function modalProgramadosFS(vehiculoId, programados) {
  const v = vehiculos.find(x => x.id === vehiculoId);
  const conViajes = programados.filter(p => p.viajes > 0);
  const limpios = programados.filter(p => !p.viajes);

  abrirModal('Días ya programados', `
    <div class="nota avi" style="margin-bottom:1rem">
      <b>${esc(v?.placa || '')}</b> tiene <b>${programados.length} día(s)</b> programados
      dentro de ese rango. Mientras sigan ahí, el itinerario dice que el vehículo sale.
    </div>
    <div class="tabla-env"><table>
      <thead><tr><th>Día</th><th>Destino</th><th></th></tr></thead>
      <tbody>${programados.map(p => `<tr>
        <td>${esc(p.fecha)}</td>
        <td>${esc(p.destino || TIPOS_JORNADA[p.tipo_jornada]?.et || '')}</td>
        <td>${p.viajes ? '<span class="etq verde">ya tiene viajes</span>' : ''}</td>
      </tr>`).join('')}</tbody></table></div>
    ${conViajes.length ? `<div class="nota avi" style="margin-top:.8rem">
      ${conViajes.length} de esos días <b>ya tienen viajes registrados</b> por el
      conductor. Esos no se pueden cancelar, y además significan que el vehículo
      sí operó: revise las fechas del período.
    </div>` : ''}`,
    `<button class="btn sec" onclick="cerrarYVolverFS(${vehiculoId})">Dejarlos como están</button>
     ${limpios.length ? `<button class="btn rojo" id="fsp-btn"
       onclick="cancelarProgramadosFS(${vehiculoId},${JSON.stringify(limpios.map(p => p.id)).replace(/"/g, '&quot;')})">
       Cancelar los ${limpios.length} días</button>` : ''}`);
}

function cerrarYVolverFS(vehiculoId) {
  cerrarModal();
  if (vistaActual === 'itinerario') verItinerario();
  else if (vistaActual === 'vehiculos') verVehiculos();
}

async function cancelarProgramadosFS(vehiculoId, ids) {
  const btn = $('#fsp-btn'); btn.disabled = true; btn.textContent = 'Cancelando...';
  let hechos = 0; const fallos = [];
  for (const id of ids) {
    try {
      await api('/api/itinerario/' + id, {
        metodo: 'DELETE', cuerpo: { motivo: 'Vehículo fuera de servicio' },
      });
      hechos++;
    } catch (e) { fallos.push(e.message); }
  }
  cerrarModal();
  aviso(fallos.length
    ? `${hechos} cancelado(s); ${fallos.length} no se pudo: ${fallos[0]}`
    : `${hechos} día(s) cancelado(s)`, fallos.length ? 'avi' : 'ok', 'Listo');
  if (vistaActual === 'itinerario') verItinerario();
  else if (vistaActual === 'vehiculos') verVehiculos();
}

async function borrarPeriodoFS(vehiculoId, id) {
  const p = fsDelVehiculo.find(x => x.id === id);
  abrirModal('Borrar el período', `
    <div class="nota avi">
      Se va a borrar el período del <b>${esc(p?.fecha_inicio || '')}</b>
      ${p?.fecha_fin ? 'al <b>' + esc(p.fecha_fin) + '</b>' : 'en adelante'}.
      Esos días vuelven a contarse como antes.
    </div>
    <p style="font-size:.85rem;color:var(--text-soft);margin:.8rem 0 0">
      Borrar es para lo que se registró <b>por error</b>. Si el vehículo sí estuvo
      parado y ya volvió, lo correcto es <b>ponerle fecha de fin</b>, no borrarlo:
      así queda el rastro de los días que no operó.</p>`,
    `<button class="btn sec" onclick="modalFueraServicio(${vehiculoId})">Volver</button>
     <button class="btn rojo" id="fsb-btn"
       onclick="confirmarBorradoFS(${vehiculoId},${id})">Borrar</button>`);
}

async function confirmarBorradoFS(vehiculoId, id) {
  const btn = $('#fsb-btn'); btn.disabled = true; btn.textContent = 'Borrando...';
  try {
    await api('/api/fuera-servicio/' + id, { metodo: 'DELETE', cuerpo: {} });
    aviso('Período borrado', 'ok', 'Listo');
    if (vistaActual === 'vehiculos') await verVehiculos();
    modalFueraServicio(vehiculoId);
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo borrar');
    btn.disabled = false; btn.textContent = 'Borrar';
  }
}

async function verVehiculos() {
  // Las personas hacen falta para el selector de conductor predeterminado.
  // El resumen de días parados no debe tumbar la pantalla si falla —por ejemplo
  // contra un Worker viejo—: se dibuja igual, sin esa columna.
  let abiertos = [], totalesFS = new Map();
  [vehiculos, personas] = await Promise.all([
    api('/api/vehiculos?todos=1'),
    api('/api/personas'),
  ]);
  try {
    const res = await api('/api/fuera-servicio/resumen');
    abiertos = res.abiertos || [];
    totalesFS = new Map((res.vehiculos || []).map(x => [x.vehiculo_id, x]));
  } catch { /* sin resumen se sigue */ }
  const abiertoDe = id => abiertos.find(a => a.vehiculo_id === id);

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Vehículos</h1><p>${vehiculos.length} registrado(s)${
        abiertos.length ? ` · <b style="color:var(--rojo)">${abiertos.length} fuera de servicio ahora</b>` : ''}</p></div>
      <button class="btn" onclick="modalVehiculo()">Registrar vehículo</button>
    </div>
    ${vehiculos.length ? `<div class="tabla-env"><table>
      <thead><tr><th>Placa</th><th>Tipo</th><th>Base</th><th>Conductor</th>
        <th>Propiedad</th><th class="num">Valor día</th><th>Estado</th>
        <th>Fuera de servicio</th><th></th></tr></thead>
      <tbody>${vehiculos.map(v => `
        <tr>
          <td class="placa">${esc(v.placa)}</td>
          <td>${esc(v.tipo)}${v.subtipo ? ' ' + esc(v.subtipo) : ''}</td>
          <td>${esc(v.municipio_base || '—')}</td>
          <td>${esc(v.conductor_actual?.trim() || '—')}</td>
          <td><span class="etq ${v.propiedad === 'contratista' ? 'ambar' : 'gris'}">${esc(v.propiedad)}</span>
            ${v.contratista ? `<br><span style="font-size:.7rem;color:var(--muted)">${esc(v.contratista)}</span>` : ''}</td>
          <td class="num">${v.valor_dia ? pesos(v.valor_dia) : '—'}</td>
          <td>${v.activo ? `<span class="etq ${v.estado === 'activo' ? 'verde' : 'ambar'}">${esc(v.estado)}</span>`
            : '<span class="etq gris">inactivo</span>'}
            ${v.docs_vencidos ? `<br><span class="etq rojo">${v.docs_vencidos} doc. vencido(s)</span>` : ''}</td>
          <td>${(() => {
            const ab = abiertoDe(v.id), tot = totalesFS.get(v.id);
            return `${ab ? `<span class="etq rojo" title="Desde el ${ab.fecha_inicio}">
                parado desde ${esc(ab.fecha_inicio.slice(5))}</span><br>` : ''}
              <span style="font-size:.72rem;color:var(--muted)">${
                tot ? `${tot.dias} día(s) en total` : 'sin días registrados'}</span>`;
          })()}</td>
          <td style="white-space:nowrap">
            <button class="btn sec sm" onclick="modalFueraServicio(${v.id})"
              title="Días en que no pudo operar">Averías</button>
            <button class="btn sec sm" onclick="modalVehiculo(${v.id})">Editar</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="card"><div class="vacio">
          <p>No hay vehículos registrados.</p>
          <button class="btn" onclick="modalVehiculo()">Registrar el primero</button></div></div>`}`;
}

function modalVehiculo(id) {
  const v = id ? vehiculos.find(x => x.id === id) : null;
  const conductores = personas.filter(p => p.es_conductor);
  const sel = (val, opciones) => opciones.map(o =>
    `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('');

  abrirModal(v ? 'Editar vehículo' : 'Registrar vehículo', `
    <div class="campo"><label class="lb">Placa <span class="req">*</span></label>
      <input class="inp" id="v-placa" value="${esc(v?.placa || '')}" ${v ? 'disabled' : ''}
        placeholder="Ej: GEU-665" style="text-transform:uppercase"></div>
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Tipo</label>
        <select class="inp" id="v-tipo">${sel(v?.tipo || 'camioneta', ['camioneta', 'ambulancia', 'moto', 'fluvial', 'otro'])}</select></div>
      <div class="campo"><label class="lb">Municipio base</label>
        <select class="inp" id="v-mun"><option value="">— Ninguno —</option>
          ${cat.municipios.map(m => `<option value="${m.id}" ${v?.municipio_base_id == m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('')}</select></div>
    </div>
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Marca</label><input class="inp" id="v-marca" value="${esc(v?.marca || '')}"></div>
      <div class="campo"><label class="lb">Modelo (año)</label><input class="inp" id="v-anio" type="number" value="${v?.modelo_anio || ''}"></div>
    </div>
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Propiedad</label>
        <select class="inp" id="v-prop" onchange="$('#v-contr-campo').style.display=this.value==='contratista'?'':'none'">
          ${sel(v?.propiedad || 'propio', ['propio', 'contratista', 'comodato'])}</select></div>
      <div class="campo"><label class="lb">Valor por día</label>
        <input class="inp" id="v-valor" type="number" value="${v?.valor_dia || ''}" placeholder="Ej: 180000"></div>
    </div>
    <div class="campo" id="v-contr-campo" style="display:${v?.propiedad === 'contratista' ? '' : 'none'}">
      <label class="lb">Contratista</label>
      <input class="inp" id="v-contr" list="lista-contratistas" value="${esc(v?.contratista || '')}"
        placeholder="Escoja una persona o escriba la razón social">
      <datalist id="lista-contratistas">
        ${personas.map(p => `<option value="${esc((p.nombres + ' ' + (p.apellidos || '')).trim())}">`).join('')}
      </datalist>
      <p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0">
        Se despliegan las personas registradas. Si el contrato está a nombre de una
        empresa, escriba la razón social.</p></div>
    <div class="campo">
      <label class="lb">Conductor predeterminado</label>
      <select class="inp" id="v-conductor">
        <option value="">— Sin asignar —</option>
        ${conductores.map(p => `<option value="${p.id}" ${v?.conductor_id == p.id ? 'selected' : ''}>${esc(p.nombres)} ${esc(p.apellidos || '')}</option>`).join('')}
      </select>
      <p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0">
        Se propone solo al programar el itinerario; se puede cambiar cualquier día.
        ${conductores.length ? '' : 'Primero registre personas marcadas como conductor.'}</p></div>
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Estado</label>
        <select class="inp" id="v-estado">${sel(v?.estado || 'activo', ['activo', 'mantenimiento', 'taller', 'fuera_servicio', 'reserva'])}</select></div>
      <div class="campo"><label class="lb">Kilometraje</label><input class="inp" id="v-km" type="number" value="${v?.km_actual || ''}"></div>
    </div>
    ${v ? `<div class="campo"><label class="lb">
      <input type="checkbox" id="v-activo" ${v.activo ? 'checked' : ''}> Vehículo activo</label></div>` : ''}`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn" id="v-btn" onclick="guardarVehiculo(${id || 'null'})">Guardar</button>`);
}

async function guardarVehiculo(id) {
  const btn = $('#v-btn'); btn.disabled = true; btn.textContent = 'Guardando...';
  const c = {
    tipo: $('#v-tipo').value,
    municipio_base_id: $('#v-mun').value ? Number($('#v-mun').value) : null,
    marca: $('#v-marca').value.trim() || null,
    modelo_anio: $('#v-anio').value ? Number($('#v-anio').value) : null,
    propiedad: $('#v-prop').value,
    contratista: $('#v-prop').value === 'contratista' ? ($('#v-contr').value.trim() || null) : null,
    valor_dia: $('#v-valor').value ? Number($('#v-valor').value) : null,
    estado: $('#v-estado').value,
    km_actual: $('#v-km').value ? Number($('#v-km').value) : null,
    conductor_id: $('#v-conductor').value ? Number($('#v-conductor').value) : null,
  };
  if (!id) {
    c.placa = $('#v-placa').value.trim().toUpperCase();
    if (!c.placa) { btn.disabled = false; btn.textContent = 'Guardar'; return aviso('La placa es obligatoria', 'mal'); }
  } else {
    c.activo = $('#v-activo')?.checked ? 1 : 0;
  }
  try {
    if (id) await api('/api/vehiculos/' + id, { metodo: 'PUT', cuerpo: c });
    else await api('/api/vehiculos', { metodo: 'POST', cuerpo: c });
    cerrarModal(); aviso('Vehículo guardado', 'ok', 'Listo'); verVehiculos();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

// ── Personas ─────────────────────────────────────────────────────────────────
async function verPersonas() {
  personas = await api('/api/personas');
  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Personas</h1><p>${personas.length} registrada(s)</p></div>
      <button class="btn" onclick="modalPersona()">Registrar persona</button>
    </div>
    <div class="nota" style="margin-bottom:.85rem">
      Los datos personales se guardan solo en esta aplicación, nunca en el repositorio de código.
    </div>
    ${personas.length ? `<div class="tabla-env"><table>
      <thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Municipio</th><th>Rol</th><th></th></tr></thead>
      <tbody>${personas.map(p => `
        <tr>
          <td><b>${esc(p.nombres)} ${esc(p.apellidos || '')}</b></td>
          <td>${p.numero_doc ? esc(p.numero_doc) : '<span class="etq ambar">falta</span>'}</td>
          <td>${p.telefono ? esc(p.telefono) : '<span class="etq ambar">falta</span>'}</td>
          <td>${esc(p.municipio || '—')}</td>
          <td>${p.es_conductor ? '<span class="etq azul">Conductor</span> ' : ''}${p.es_tripulante ? '<span class="etq morado">Tripulante</span>' : ''}</td>
          <td><button class="btn sec sm" onclick="modalPersona(${p.id})">Editar</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="card"><div class="vacio">
          <p>No hay personas registradas.</p>
          <button class="btn" onclick="modalPersona()">Registrar la primera</button></div></div>`}`;
}

function modalPersona(id) {
  const p = id ? personas.find(x => x.id === id) : null;
  abrirModal(p ? 'Editar persona' : 'Registrar persona', `
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Nombres <span class="req">*</span></label>
        <input class="inp" id="p-nom" value="${esc(p?.nombres || '')}"></div>
      <div class="campo"><label class="lb">Apellidos</label>
        <input class="inp" id="p-ape" value="${esc(p?.apellidos || '')}"></div>
    </div>
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Documento</label>
        <input class="inp" id="p-doc" value="${esc(p?.numero_doc || '')}" inputmode="numeric"></div>
      <div class="campo"><label class="lb">Teléfono</label>
        <input class="inp" id="p-tel" value="${esc(p?.telefono || '')}" inputmode="tel"></div>
    </div>
    <div class="grid g2" style="gap:0 .75rem">
      <div class="campo"><label class="lb">Municipio base</label>
        <select class="inp" id="p-mun"><option value="">— Ninguno —</option>
          ${cat.municipios.map(m => `<option value="${m.id}" ${p?.municipio_id == m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('')}</select>
        <p style="font-size:.7rem;color:var(--muted);margin:.25rem 0 0">Solo precarga el formulario; puede desplazarse a cualquier municipio.</p></div>
      <div class="campo"><label class="lb">Vinculación</label>
        <select class="inp" id="p-vinc"><option value="">— Ninguna —</option>
          ${['planta', 'contrato', 'ops', 'tercero'].map(v => `<option value="${v}" ${p?.vinculacion === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="campo"><label class="lb">Correo</label><input class="inp" id="p-cor" type="email" value="${esc(p?.correo || '')}"></div>
    <div class="campo">
      <label class="lb" style="display:block;margin-bottom:.4rem">Función</label>
      <label style="display:inline-flex;gap:.35rem;align-items:center;margin-right:1rem;font-size:.88rem">
        <input type="checkbox" id="p-cond" ${p?.es_conductor ? 'checked' : ''}> Conductor</label>
      <label style="display:inline-flex;gap:.35rem;align-items:center;font-size:.88rem">
        <input type="checkbox" id="p-trip" ${p?.es_tripulante ? 'checked' : ''}> Tripulante</label>
    </div>`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn" id="p-btn" onclick="guardarPersona(${id || 'null'})">Guardar</button>`);
}

async function guardarPersona(id) {
  const nombres = $('#p-nom').value.trim();
  if (!nombres) return aviso('El nombre es obligatorio', 'mal');
  const btn = $('#p-btn'); btn.disabled = true; btn.textContent = 'Guardando...';
  const c = {
    nombres, apellidos: $('#p-ape').value.trim() || null,
    numero_doc: $('#p-doc').value.trim() || null,
    telefono: $('#p-tel').value.trim() || null,
    correo: $('#p-cor').value.trim() || null,
    municipio_id: $('#p-mun').value ? Number($('#p-mun').value) : null,
    vinculacion: $('#p-vinc').value || null,
    es_conductor: $('#p-cond').checked ? 1 : 0,
    es_tripulante: $('#p-trip').checked ? 1 : 0,
  };
  try {
    if (id) await api('/api/personas/' + id, { metodo: 'PUT', cuerpo: c });
    else await api('/api/personas', { metodo: 'POST', cuerpo: c });
    cerrarModal(); aviso('Persona guardada', 'ok', 'Listo'); verPersonas();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

// ── Usuarios (solo el rol principal) ─────────────────────────────────────────
async function verUsuarios() {
  const us = await api('/api/usuarios');
  const ROL = { principal: ['rojo', 'Administrador'], coordinacion: ['azul', 'Coordinación'], conductor: ['verde', 'Conductor'] };

  $('#main').innerHTML = `
    <div class="cab">
      <div><h1>Usuarios</h1><p>${us.length} cuenta(s) · usted es el único que puede crearlas</p></div>
      <button class="btn" onclick="modalUsuario()">Crear usuario</button>
    </div>
    <div class="tabla-env"><table>
      <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Último ingreso</th><th>Estado</th><th></th></tr></thead>
      <tbody>${us.map(u => {
        const r = ROL[u.rol] || ['gris', u.rol];
        return `<tr>
          <td><b>${esc(u.usuario)}</b></td>
          <td>${u.sin_persona
            ? '<span class="etq rojo">sin persona vinculada</span>'
            : esc(u.nombre?.trim() || '—')}</td>
          <td><span class="etq ${r[0]}">${r[1]}</span></td>
          <td>${u.ultimo_acceso ? fechaHora(u.ultimo_acceso) : '<span style="color:var(--muted)">nunca</span>'}</td>
          <td>${u.activo ? '<span class="etq verde">Activo</span>' : '<span class="etq gris">Inactivo</span>'}
            ${u.debe_cambiar_clave ? '<br><span class="etq ambar">clave temporal</span>' : ''}</td>
          <td><button class="btn sec sm" onclick="modalUsuario(${u.id})">Editar</button></td>
        </tr>`; }).join('')}</tbody></table></div>
    ${us.some(u => u.sin_persona) ? `
      <div class="nota avi" style="margin-top:.85rem">
        <b>Hay cuentas de conductor sin persona vinculada.</b>
        Esas cuentas entran pero no ven su itinerario, porque la programación se asigna
        a la persona y no al usuario. Ábralas y escoja la persona correspondiente.
      </div>` : ''}
    <div class="nota" style="margin-top:.85rem">
      No existe registro por cuenta propia ni recuperación de clave por correo: usted crea la cuenta
      con una clave temporal y el usuario la cambia al entrar por primera vez.
    </div>`;
  window._usuarios = us;
}

function modalUsuario(id) {
  const u = id ? window._usuarios.find(x => x.id === id) : null;
  const sinCuenta = personas.filter(p => !window._usuarios.some(x => x.persona_id === p.id && x.id !== id));

  abrirModal(u ? 'Editar usuario' : 'Crear usuario', `
    <div class="campo"><label class="lb">Nombre de usuario <span class="req">*</span></label>
      <input class="inp" id="u-usuario" value="${esc(u?.usuario || '')}" autocapitalize="none"
        placeholder="Ej: jnavarro"></div>
    <div class="campo"><label class="lb">Rol <span class="req">*</span></label>
      <select class="inp" id="u-rol" onchange="usuarioToggleRol()">
        <option value="conductor" ${u?.rol === 'conductor' ? 'selected' : ''}>Conductor — marca salida y llegada, reporta novedades</option>
        <option value="coordinacion" ${u?.rol === 'coordinacion' ? 'selected' : ''}>Coordinación — ve todo, descarga y modifica itinerarios</option>
        <option value="principal" ${u?.rol === 'principal' ? 'selected' : ''}>Administrador — control total y creación de usuarios</option>
      </select></div>
    <div class="campo">
      <label class="lb">Persona vinculada <span class="req" id="u-persona-req">*</span></label>
      <select class="inp" id="u-persona"><option value="">— Ninguna —</option>
        ${sinCuenta.map(p => `<option value="${p.id}" ${u?.persona_id == p.id ? 'selected' : ''}>${esc(p.nombres)} ${esc(p.apellidos || '')}${p.es_conductor ? '' : ' (no marcada como conductor)'}</option>`).join('')}
      </select>
      <p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0" id="u-persona-nota">
        Obligatorio para los conductores: es lo que conecta la cuenta con su itinerario.
        Sin esto la persona entra pero no ve nada.</p>
      ${sinCuenta.length ? '' : `<div class="nota avi" style="margin-top:.4rem">
        No hay personas disponibles para vincular. Regístrela primero en
        <b>Personas</b>, marcada como conductor.</div>`}
    </div>
    <div class="campo"><label class="lb">Correo</label><input class="inp" id="u-correo" type="email" value="${esc(u?.correo || '')}"></div>
    <div class="campo"><label class="lb">${u ? 'Nueva clave temporal (dejar vacío para no cambiarla)' : 'Clave temporal'} ${u ? '' : '<span class="req">*</span>'}</label>
      <input class="inp" id="u-clave" placeholder="Mínimo 8 caracteres">
      <p style="font-size:.72rem;color:var(--muted);margin:.25rem 0 0">
        Anótela y entréguesela a la persona. El sistema le exige cambiarla al entrar.</p></div>
    ${u ? `<div class="campo"><label class="lb">
      <input type="checkbox" id="u-activo" ${u.activo ? 'checked' : ''}> Cuenta activa</label></div>` : ''}`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     <button class="btn" id="u-btn" onclick="guardarUsuario(${id || 'null'})">Guardar</button>`);
  usuarioToggleRol();
}

function usuarioToggleRol() {
  const esConductor = $('#u-rol')?.value === 'conductor';
  const req = $('#u-persona-req');
  if (req) req.style.display = esConductor ? '' : 'none';
  const nota = $('#u-persona-nota');
  if (nota) {
    nota.textContent = esConductor
      ? 'Obligatorio: es lo que conecta la cuenta con su itinerario. Sin esto la persona entra pero no ve nada.'
      : 'Opcional para coordinación y administración.';
  }
}

async function guardarUsuario(id) {
  const btn = $('#u-btn'); btn.disabled = true; btn.textContent = 'Guardando...';
  const clave = $('#u-clave').value;
  const c = {
    usuario: $('#u-usuario').value.trim().toLowerCase(),
    rol: $('#u-rol').value,
    persona_id: $('#u-persona').value ? Number($('#u-persona').value) : null,
    correo: $('#u-correo').value.trim() || null,
  };
  if (clave) c.clave = clave;
  if (id) c.activo = $('#u-activo')?.checked ? 1 : 0;

  if (!c.usuario || (!id && !clave)) {
    btn.disabled = false; btn.textContent = 'Guardar';
    return aviso('Indique el usuario y la clave temporal', 'mal', 'Faltan datos');
  }
  if (c.rol === 'conductor' && !c.persona_id) {
    btn.disabled = false; btn.textContent = 'Guardar';
    return aviso('Escoja la persona: sin ella la cuenta no verá su itinerario',
                 'mal', 'Falta la persona');
  }
  try {
    if (id) await api('/api/usuarios/' + id, { metodo: 'PUT', cuerpo: c });
    else await api('/api/usuarios', { metodo: 'POST', cuerpo: c });
    cerrarModal();
    aviso(clave ? `Entregue la clave a ${c.usuario}. Se la pedirá cambiar al entrar.` : 'Usuario actualizado',
          'ok', 'Listo');
    verUsuarios();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo guardar');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

// ── Ajustes ──────────────────────────────────────────────────────────────────
const EXPLICA = {
  checklist_bloquea_salida: ['¿Qué pasa si falta un distintivo?',
    [['advertir', 'Solo advertir y dejar registrado'], ['bloquear', 'Impedir la salida']]],
  dia_disponible_es_pagable: ['¿Un día disponible en base se paga?',
    [['1', 'Sí, igual que un día con desplazamiento'], ['0', 'No']]],
  gps_obligatorio: ['¿Exigir ubicación al marcar?', [['1', 'Sí'], ['0', 'No']]],
  gps_precision_maxima_m: ['Precisión máxima aceptada (metros)', null],
  dias_alerta_vencimiento: ['Avisar vencimientos con esta anticipación (días)', null],
  umbral_discrepancia_dias: ['Diferencia tolerada con el soporte firmado (días)', null],
  correo_alertas: ['Correos para las alertas (separados por coma)', null],
  foto_obligatoria: ['¿Exigir fotografía al salir y al llegar?', [['1', 'Sí'], ['0', 'No']]],
  app_foto_activa: ['¿Con qué se toma la fotografía?',
    [['1', 'Con una aplicación externa (Timemark)'], ['0', 'Con la cámara del teléfono']]],
  app_foto_nombre: ['Nombre de esa aplicación, como se le muestra al conductor', null],
  app_foto_android: ['Identificador en Google Play', null],
  app_foto_ios: ['Identificador en la App Store', null],
  foto_antiguedad_minutos: ['Avisar si la foto adjuntada es más vieja que (minutos)', null],
};

async function verAjustes() {
  const ps = await api('/api/parametros');
  $('#main').innerHTML = `
    <div class="cab"><div><h1>Ajustes</h1><p>Reglas de operación. Solo usted puede cambiarlas.</p></div></div>
    ${ps.map(p => {
      const [et, ops] = EXPLICA[p.clave] || [p.clave, null];
      return `<div class="card" style="margin-bottom:.75rem">
        <label class="lb" style="font-size:.85rem;text-transform:none;letter-spacing:0">${esc(et)}</label>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.4rem">
          ${ops
            ? `<select class="inp" id="par-${p.clave}" style="flex:1;min-width:220px">
                 ${ops.map(([v, e]) => `<option value="${v}" ${p.valor === v ? 'selected' : ''}>${e}</option>`).join('')}
               </select>`
            : `<input class="inp" id="par-${p.clave}" value="${esc(p.valor)}" style="flex:1;min-width:220px">`}
          <button class="btn sm" onclick="guardarParametro('${p.clave}')">Guardar</button>
        </div>
        ${p.descripcion ? `<p style="font-size:.72rem;color:var(--muted);margin:.4rem 0 0">${esc(p.descripcion)}</p>` : ''}
      </div>`;
    }).join('')}
    <div class="card" style="margin-bottom:.75rem">
      <h3>Banner institucional</h3>
      <p style="font-size:.85rem;color:var(--text-soft);margin:.3rem 0 .75rem">
        Aparece en la pantalla de ingreso, en el encabezado de la aplicación y en el
        PDF del itinerario. Tamaño ideal <b>2000 × 289 px</b>; si sube otro tamaño se
        ajusta solo, sin deformarlo.</p>
      ${banner ? `
        <div class="banner" style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:.75rem">
          <img src="${bannerUrl()}" alt="Banner actual">
        </div>` : '<div class="nota" style="margin-bottom:.75rem">Todavía no hay banner cargado.</div>'}
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn sec" onclick="$('#archivo-banner').click()">
          ${banner ? 'Reemplazar' : 'Subir banner'}</button>
        ${banner ? '<button class="btn sec" onclick="quitarBanner()">Quitar</button>' : ''}
        <input type="file" id="archivo-banner" accept="image/png,image/jpeg,image/webp"
          style="display:none" onchange="subirBanner(this)">
      </div>
    </div>

    <div class="card">
      <h3>Auditoría</h3>
      <p style="font-size:.85rem;color:var(--text-soft);margin:.3rem 0 .75rem">
        Registro de quién hizo qué y cuándo. No se puede modificar ni borrar.</p>
      <button class="btn sec" onclick="verAuditoria()">Ver los últimos 200 movimientos</button>
    </div>`;
}

async function guardarParametro(clave) {
  try {
    await api('/api/parametros/' + clave, { metodo: 'PUT', cuerpo: { valor: $('#par-' + clave).value } });
    parametros[clave] = $('#par-' + clave).value;
    aviso('Ajuste guardado', 'ok');
  } catch (e) { aviso(e.message, 'mal', 'No se pudo guardar'); }
}

async function verAuditoria() {
  const a = await api('/api/auditoria?limite=200');
  abrirModal('Auditoría', `<div class="tabla-env" style="border:0"><table>
    <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué</th></tr></thead>
    <tbody>${a.map(x => `
      <tr><td style="white-space:nowrap">${fechaHora(x.ts)}</td>
        <td>${esc(x.nombre?.trim() || x.usuario || '—')}<br><span style="font-size:.68rem;color:var(--muted)">${esc(x.rol || '')}</span></td>
        <td>${esc(x.accion)} <b>${esc(x.entidad)}</b>${x.entidad_id ? ' #' + x.entidad_id : ''}</td></tr>`).join('')}
    </tbody></table></div>`);
}

// ── Arranque ─────────────────────────────────────────────────────────────────
/**
 * Arranque.
 *
 * ESTE ERA EL FALLO que dejaba la aplicación inservible sin señal: se validaba
 * la sesión contra el servidor y CUALQUIER fallo —incluido no tener datos—
 * llamaba a salir(), que borra la sesión guardada. El conductor quedaba en la
 * pantalla de ingreso y no podía entrar, porque entrar también necesita red.
 * Desde su lado, "la aplicación no abre sin internet".
 *
 * Ahora se entra de una vez con la sesión guardada y la comprobación va por
 * detrás: solo se cierra la sesión si el servidor CONTESTA que ya no vale.
 */
(function arrancar() {
  try {
    const guardada = JSON.parse(localStorage.getItem('flota_sesion') || 'null');
    if (guardada?.token) {
      sesion = guardada;
      iniciar();                       // no se espera al servidor para abrir
      api('/api/auth/yo')
        .then(u => { sesion = { ...sesion, ...u }; localStorage.setItem('flota_sesion', JSON.stringify(sesion)); })
        .catch(e => { if (!esFalloDeRed(e)) salir(true); });
      return;
    }
  } catch { /* sesión ilegible: se pide ingreso */ }
  $('#ingreso').style.display = 'flex';
})();

cargarBanner();          // también en la pantalla de ingreso, sin sesión

// ═══════════════════════════════════════════════════════════════════════════
// INSTALACIÓN EN EL TELÉFONO
//
// La aplicación se instala desde el mismo navegador: no pasa por Play Store ni
// por App Store, no ocupa casi nada y se actualiza sola. Una vez instalada el
// conductor la abre desde el icono, a pantalla completa y sin barra de
// direcciones, y si sale de cobertura la aplicación abre igual y guarda las
// marcas hasta que vuelva la señal.
//
// Cada sistema la ofrece a su manera:
//
//   · Android (Chrome) avisa por su cuenta con el evento beforeinstallprompt.
//     Lo interceptamos para guardar el aviso y ofrecerlo nosotros donde tiene
//     sentido —una franja visible— en vez de dejar el globo del navegador, que
//     se cierra al primer toque y no vuelve a aparecer.
//   · iPhone y iPad no tienen ese evento y NO SE PUEDE instalar por código:
//     solo cabe explicar los tres toques del menú Compartir de Safari.
//   · En el computador Chrome y Edge también instalan; Firefox no.
// ═══════════════════════════════════════════════════════════════════════════

let avisoInstalar = null;        // evento beforeinstallprompt guardado
const OCULTAR_INSTALAR = 'flota_instalar_oculto';
const DIAS_SILENCIO = 21;        // si la cierra, no se insiste en tres semanas

/** ¿Se está viendo ya como aplicación instalada y no dentro del navegador? */
const estaInstalada = () =>
  ['standalone', 'minimal-ui', 'window-controls-overlay']
    .some(m => window.matchMedia?.(`(display-mode: ${m})`)?.matches) ||
  navigator.standalone === true;

/**
 * ¿Cerró la franja hace poco?
 *
 * Con try: en el modo privado de algunos navegadores localStorage lanza, y
 * esto se llama desde el arranque — un error aquí abortaría el resto del
 * archivo y dejaría media aplicación sin cargar.
 */
function silenciada() {
  try {
    return Date.now() < Number(localStorage.getItem(OCULTAR_INSTALAR) || 0);
  } catch { return false; }
}

const ICONO_INSTALAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

window.addEventListener('beforeinstallprompt', ev => {
  ev.preventDefault();           // se muestra cuando y donde nosotros queramos
  avisoInstalar = ev;
  pintarInstalar();
});

window.addEventListener('appinstalled', () => {
  avisoInstalar = null;
  pintarInstalar();
  aviso('Ya puede abrirla desde el icono del celular, sin entrar al navegador',
        'ok', 'Aplicación instalada');
});

/**
 * Coloca el ofrecimiento en los dos sitios donde puede hacer falta: la franja
 * de la aplicación y el pie del ingreso —este último importa más de lo que
 * parece, porque el conductor instala antes de tener con qué entrar—.
 */
function pintarInstalar() {
  const franja = $('#barra-instalar');
  const pie = $('#instalar-ingreso');
  // En el computador solo se ofrece si el navegador de verdad instala; en el
  // celular siempre, porque ahí el instructivo a mano sí tiene sentido.
  const puede = !estaInstalada() && (avisoInstalar || esMovil());

  if (franja) {
    const mostrar = puede && avisoInstalar && !silenciada();
    franja.classList.toggle('on', !!mostrar);
    if (mostrar && !franja.dataset.listo) {
      franja.dataset.listo = '1';
      franja.innerHTML =
        `<span>Instale la aplicación en el celular para abrirla sin el navegador</span>
         <button type="button" class="btn sm" onclick="instalarApp()">${ICONO_INSTALAR} Instalar</button>
         <button type="button" class="cerrar" onclick="silenciarInstalar()" aria-label="Ahora no">&times;</button>`;
    }
  }

  if (pie) {
    pie.innerHTML = puede
      // type="button": el botón vive dentro del formulario de ingreso y sin esto
      // lo enviaría, quedándose en "rellene este campo" en vez de instalar.
      ? `<button type="button" onclick="instalarApp()">${ICONO_INSTALAR} Instalar en este dispositivo</button>`
      : '';
  }
}

function silenciarInstalar() {
  try {
    localStorage.setItem(OCULTAR_INSTALAR, String(Date.now() + DIAS_SILENCIO * 864e5));
  } catch { /* sin almacenamiento se vuelve a ofrecer la próxima vez */ }
  $('#barra-instalar').classList.remove('on');
}

/**
 * Instala si el navegador lo permite; si no, explica los pasos a mano.
 *
 * El aviso guardado es de un solo uso: una vez mostrado hay que soltarlo, y si
 * el usuario dice que no, Chrome no lo vuelve a ofrecer hasta pasados unos
 * días. Por eso, cuando ya no queda aviso, se cae al instructivo.
 */
async function instalarApp() {
  if (!avisoInstalar) return modalComoInstalar();
  const guardado = avisoInstalar;
  avisoInstalar = null;
  try {
    guardado.prompt();
    const { outcome } = await guardado.userChoice;
    if (outcome !== 'accepted') {
      aviso('Puede instalarla más tarde desde el menú del navegador', 'avi', 'Sin instalar');
    }
  } catch {
    modalComoInstalar();
  }
  pintarInstalar();
}

/** Instructivo por sistema, para cuando el navegador no ofrece el botón. */
function modalComoInstalar() {
  if (estaInstalada()) {
    return aviso('Ya está instalada en este dispositivo', 'ok', 'Todo listo');
  }
  let pasos;
  if (esIOS()) {
    pasos = `<p class="nota">En iPhone y iPad la instalación se hace desde <b>Safari</b>
        (si abrió esta página en otra aplicación, ábrala en Safari primero).</p>
      <ol class="pasos">
        <li>Toque <b>Compartir</b>, el cuadrito con la flecha hacia arriba, en la barra de abajo.</li>
        <li>Deslice y elija <b>Añadir a pantalla de inicio</b>.</li>
        <li>Toque <b>Añadir</b>, arriba a la derecha.</li>
      </ol>
      <p class="nota">Quedará el icono azul de Flota junto a sus demás aplicaciones.</p>`;
  } else if (esMovil()) {          // Android, o un teléfono con el user agent falseado
    pasos = `<ol class="pasos">
        <li>Toque los <b>tres puntos</b> de la esquina superior derecha del navegador.</li>
        <li>Elija <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.</li>
        <li>Confirme con <b>Instalar</b>.</li>
      </ol>
      <p class="nota">Si no aparece la opción, use <b>Chrome</b>: es el que instala
        aplicaciones en Android.</p>`;
  } else {
    pasos = `<ol class="pasos">
        <li>En <b>Chrome</b> o <b>Edge</b>, mire el extremo derecho de la barra de direcciones.</li>
        <li>Toque el icono de instalar (una pantalla con una flecha hacia abajo)
            o abra el menú <b>⋮</b> y elija <b>Instalar</b>.</li>
      </ol>
      <p class="nota">La instalación en el computador es opcional; donde de verdad
        sirve es en el celular del conductor, porque funciona sin señal.</p>`;
  }
  abrirModal('Cómo instalar la aplicación', pasos);
}

// ── Service worker: es lo que permite abrir sin señal ────────────────────────
//
// Guarda el armazón de la aplicación (pantalla, código y librerías) en el
// teléfono. Los datos NO se guardan: un itinerario viejo sería peor que
// ninguno. Las marcas tomadas sin cobertura las guarda la propia aplicación.

// ¿Había ya un service worker mandando en esta página al cargarla? Se mira
// antes de registrar nada, porque registrar cambia la respuesta.
const habiaControlador = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
let pedimosRelevo = false;      // el conductor tocó "Actualizar"
let recargando = false;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(reg => {
      // Una aplicación instalada no se recarga con F5: si hay versión nueva hay
      // que decirlo dentro, o el conductor se queda meses con la vieja.
      const vigilar = trabajador => trabajador.addEventListener('statechange', () => {
        if (trabajador.state === 'installed' && navigator.serviceWorker.controller) {
          ofrecerActualizacion(trabajador);
        }
      });
      // Puede haber quedado una versión esperando de una visita anterior en la
      // que el conductor no tocó "Actualizar": entonces no habrá updatefound.
      if (reg.waiting && navigator.serviceWorker.controller) ofrecerActualizacion(reg.waiting);
      reg.addEventListener('updatefound', () => { if (reg.installing) vigilar(reg.installing); });
      setInterval(() => reg.update().catch(() => {}), 30 * 60000);
    })
    .catch(() => { /* sin service worker la aplicación funciona igual, con señal */ });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recargando) return;
    // La PRIMERA instalación también dispara este evento. Recargar ahí haría
    // parpadear la pantalla al primer visitante y le borraría lo que estuviera
    // escribiendo. Solo se recarga si el relevo lo pidió el conductor, o si ya
    // había una versión mandando y la relevaron por detrás.
    if (!pedimosRelevo && !habiaControlador) return;
    recargando = true;
    location.reload();
  });
}

/** Franja verde: hay versión nueva esperando, pero entra cuando el usuario diga. */
function ofrecerActualizacion(trabajador) {
  const franja = $('#barra-nueva');
  if (!franja) return;
  franja.innerHTML = `<span>Hay una versión nueva de la aplicación</span>
    <button type="button" class="btn sm verde" id="btn-actualizar">Actualizar</button>`;
  franja.classList.add('on');
  $('#btn-actualizar').onclick = () => {
    $('#btn-actualizar').disabled = true;
    pedimosRelevo = true;
    trabajador.postMessage({ tipo: 'saltar-espera' });   // al activarse, recarga sola
  };
}

pintarInstalar();

// ═══════════════════════════════════════════════════════════════════════════
// PLANTILLA DE EXCEL
//
// Matriz igual a la que ya usaba Coordinación (vehículos en filas, días en
// columnas), con tres añadidos que la hacen inequívoca al volver a cargarla:
//
//   1. La fila de encabezado lleva la fecha en formato ISO (2026-09-14). Es la
//      llave de lectura: no depende del idioma ni del formato de fecha de Excel.
//   2. Cada celda admite UN valor de una lista cerrada — el nombre de un
//      predeterminado o de un destino — en vez de texto libre como
//      "DISPONIBLE ABREGO", que mezclaba tipo de jornada y lugar.
//   3. Una hoja OPCIONES con los valores válidos y su significado, que además
//      alimenta la lista desplegable de las celdas.
// ═══════════════════════════════════════════════════════════════════════════

const SEP_OBS = '//';          // "EBS Santa Inés // llevar termo" -> valor + observación

/**
 * Prefijo que lleva la celda cuando la jornada NO es una ruta EBS corriente.
 *
 * Sin él la exportación sería irreversible: un día de vacunación a Honduras se
 * escribiría solo "HONDURAS" y al volver a cargarlo se registraría como ruta
 * EBS, cambiando en silencio decenas de días que nadie tocó.
 */
const PREFIJO_JORNADA = {
  jornada:         'JORNADA',
  vacunacion:      'VACUNACIÓN',
  traslado_ciudad: 'FUERA DEL ÁREA',
  administrativo:  'ADMINISTRATIVO',
};
const POR_PREFIJO = Object.fromEntries(
  Object.entries(PREFIJO_JORNADA).map(([k, v]) => [v, k]));

/** Texto con el que una programación viaja a la celda de Excel. */
function etiquetaCelda(it, destino) {
  // Si hay un predeterminado que calza exacto, se usa su nombre: es el valor
  // que la lista desplegable ofrece y el más cómodo de escoger.
  const pre = predeterminados.find(p =>
    p.tipo_jornada === it.tipo_jornada &&
    (p.destino || '') === (destino || '') &&
    (p.municipio_id || null) === (it.municipio_id || null));
  if (pre) return pre.nombre;

  if (it.tipo_jornada === 'disponible') return 'DISPONIBLE';
  if (it.tipo_jornada === 'ebs') return destino || '';
  return `${PREFIJO_JORNADA[it.tipo_jornada] || it.tipo_jornada}: ${destino || ''}`.trim();
}

/** Valores que la plantilla acepta en una celda, con lo que significa cada uno. */
function opcionesPlantilla() {
  const filas = [];
  filas.push(['DISPONIBLE', 'El vehículo queda en base, sin desplazamiento',
              'Disponible', '', '']);
  for (const [tipo, prefijo] of Object.entries(PREFIJO_JORNADA)) {
    filas.push([`${prefijo}: <destino>`,
                `Escriba el prefijo, dos puntos y el destino. Ej: ${prefijo}: ASERRÍO`,
                TIPOS_JORNADA[tipo].et, '', '']);
  }
  for (const p of predeterminados) {
    filas.push([p.nombre, 'Predeterminado del banco',
                TIPOS_JORNADA[p.tipo_jornada]?.et || p.tipo_jornada,
                p.municipio || '', p.destino || '']);
  }
  for (const d of cat.destinos) {
    if (predeterminados.some(p => p.destino === d.nombre)) continue;
    filas.push([d.nombre, 'Destino del catálogo (se registra como ruta EBS)',
                'Ruta EBS', d.municipio || '', d.nombre]);
  }
  return filas;
}

async function descargarPlantilla() {
  const hasta = nDias(itinDesde, 13);
  const dias = Array.from({ length: itinDias }, (_, i) => nDias(itinDesde, i));
  const activos = vehiculos.filter(v => v.activo !== 0);
  const porClave = {};
  itinDatos.forEach(i => { porClave[i.fecha + '|' + i.vehiculo_id] = i; });

  // ── Hoja ITINERARIO ──
  const filas = [
    ['FLOTA VEHICULAR · ESE HOSPITAL REGIONAL NOROCCIDENTAL'],
    [`Itinerario del ${itinDesde} al ${hasta}`],
    ['Escriba en cada celda un valor de la hoja OPCIONES. Deje vacío si no hay programación.'],
    [`Para una nota puntual: VALOR ${SEP_OBS} su observación`],
    [],
    ['', '', ...dias.map(diaSemana)],
    ['PLACA', 'CONDUCTOR', ...dias],
  ];
  for (const v of activos) {
    filas.push([v.placa, v.conductor_actual?.trim() || '', ...dias.map(f => {
      const it = porClave[f + '|' + v.id];
      if (!it) return '';
      const base = etiquetaCelda(it, it.destino);
      return it.observaciones ? `${base} ${SEP_OBS} ${it.observaciones}` : base;
    })]);
  }

  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet(filas);
  hoja['!cols'] = [{ wch: 12 }, { wch: 24 }, ...dias.map(() => ({ wch: 20 }))];
  hoja['!freeze'] = { xSplit: 2, ySplit: 7 };
  XLSX.utils.book_append_sheet(libro, hoja, 'ITINERARIO');

  // ── Hoja OPCIONES ──
  const opciones = opcionesPlantilla();
  const hojaOp = XLSX.utils.aoa_to_sheet([
    ['VALOR', 'QUÉ SIGNIFICA', 'TIPO DE JORNADA', 'MUNICIPIO', 'DESTINO'],
    ...opciones,
  ]);
  hojaOp['!cols'] = [{ wch: 30 }, { wch: 44 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(libro, hojaOp, 'OPCIONES');

  // ── Hoja INSTRUCCIONES ──
  const hojaIns = XLSX.utils.aoa_to_sheet([
    ['CÓMO LLENAR ESTA PLANTILLA'],
    [],
    ['1.', 'Trabaje solo en la hoja ITINERARIO.'],
    ['2.', 'No cambie la fila de PLACA ni la fila de fechas: son las que el sistema lee.'],
    ['3.', 'En cada celda escriba un valor de la hoja OPCIONES, o escójalo de la lista.'],
    ['4.', 'Celda vacía significa que ese día no hay programación.'],
    ['5.', `Para agregar una nota: VALOR ${SEP_OBS} su observación.`],
    ['6.', 'Si escribe un destino que no está en OPCIONES, se creará como destino nuevo.'],
    ['7.', 'Un destino a secas se registra como ruta EBS. Para otra jornada, use el'],
    ['', 'prefijo: VACUNACIÓN: HONDURAS, JORNADA: ASERRÍO, FUERA DEL ÁREA: CÚCUTA.'],
    ['8.', 'Lo más cómodo es guardar predeterminados en la aplicación: aparecen en la'],
    ['', 'lista desplegable con un nombre propio y no hay que escribir prefijos.'],
    [],
    ['AL CARGARLO'],
    ['', 'La aplicación le muestra primero qué va a crear, cambiar y borrar.'],
    ['', 'Nada se aplica hasta que usted confirme.'],
    ['', 'Los días en los que el conductor ya marcó salida no se tocan: aparecen'],
    ['', 'como bloqueados, porque cambiarlos descuadraría la liquidación.'],
    [],
    ['Generado el', new Date().toLocaleString('es-CO')],
  ]);
  hojaIns['!cols'] = [{ wch: 6 }, { wch: 78 }];
  XLSX.utils.book_append_sheet(libro, hojaIns, 'INSTRUCCIONES');

  // Se escribe el archivo y luego se le inyecta la lista desplegable, que
  // SheetJS no sabe generar por sí solo.
  let datos = XLSX.write(libro, { bookType: 'xlsx', type: 'array' });
  try {
    datos = await inyectarLista(datos, activos.length, dias.length, opciones.length);
  } catch {
    // Si algo falla, la plantilla sirve igual: la validación real ocurre al cargarla.
  }

  const url = URL.createObjectURL(new Blob([datos],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `itinerario_${itinDesde}_a_${hasta}.xlsx`; a.click();
  URL.revokeObjectURL(url);
  aviso('Plantilla descargada', 'ok', 'Listo');
}

/**
 * Añade al .xlsx una lista desplegable en las celdas de días, tomada de la hoja
 * OPCIONES. Se hace abriendo el archivo como ZIP porque la versión libre de
 * SheetJS no escribe validación de datos.
 *
 * Se usa errorStyle="warning": avisa si el valor no está en la lista, pero deja
 * escribirlo — hace falta para poder registrar un destino nuevo.
 */
async function inyectarLista(datos, numVehiculos, numDias, numOpciones) {
  const zip = await JSZip.loadAsync(datos);
  const ruta = Object.keys(zip.files).find(n => /xl\/worksheets\/sheet1\.xml$/.test(n));
  if (!ruta) return datos;

  let xml = await zip.file(ruta).async('string');
  if (xml.includes('<dataValidations')) return datos;

  const col = n => {                       // 0 -> A, 26 -> AA
    let s = '';
    for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
  };
  const rango = `C8:${col(2 + numDias - 1)}${7 + numVehiculos}`;
  const validacion =
    `<dataValidations count="1"><dataValidation type="list" allowBlank="1"` +
    ` showInputMessage="1" showErrorMessage="1" errorStyle="warning"` +
    ` error="Ese valor no está en la hoja OPCIONES. Si es un destino nuevo, puede continuar."` +
    ` errorTitle="Valor fuera de la lista" sqref="${rango}">` +
    `<formula1>OPCIONES!$A$2:$A$${numOpciones + 1}</formula1></dataValidation></dataValidations>`;

  xml = xml.replace('</worksheet>', validacion + '</worksheet>');
  zip.file(ruta, xml);
  // 'uint8array', no 'array': JSZip devolvería un arreglo de números y el Blob
  // lo escribiría como texto, produciendo un archivo que Excel no puede abrir.
  return zip.generateAsync({ type: 'uint8array' });
}

// ── Carga de la plantilla ────────────────────────────────────────────────────

/** Traduce el texto de una celda a los campos de una programación. */
function interpretarCelda(texto) {
  const bruto = String(texto ?? '').trim();
  if (!bruto) return null;

  const corte = bruto.indexOf(SEP_OBS);
  const valor = (corte >= 0 ? bruto.slice(0, corte) : bruto).trim();
  const observaciones = corte >= 0 ? bruto.slice(corte + SEP_OBS.length).trim() : null;
  if (!valor) return null;

  const igual = a => a.trim().toLocaleUpperCase('es') === valor.toLocaleUpperCase('es');

  if (igual('DISPONIBLE')) {
    return { tipo_jornada: 'disponible', destino_nombre: null, municipio_id: null,
             observaciones, etiqueta: 'Disponible' };
  }
  const pre = predeterminados.find(p => igual(p.nombre));
  if (pre) {
    return { tipo_jornada: pre.tipo_jornada, destino_nombre: pre.destino || null,
             municipio_id: pre.municipio_id || null,
             observaciones: observaciones ?? pre.observaciones,
             etiqueta: pre.nombre };
  }
  // "VACUNACIÓN: HONDURAS" -> tipo vacunacion + destino HONDURAS
  const dosPuntos = valor.indexOf(':');
  if (dosPuntos > 0) {
    const prefijo = valor.slice(0, dosPuntos).trim().toLocaleUpperCase('es');
    const tipo = POR_PREFIJO[prefijo];
    if (tipo) {
      const nombreDest = valor.slice(dosPuntos + 1).trim();
      const d = cat.destinos.find(x =>
        x.nombre.trim().toLocaleUpperCase('es') === nombreDest.toLocaleUpperCase('es'));
      return { tipo_jornada: tipo, destino_nombre: nombreDest || null,
               municipio_id: d?.municipio_id || null, observaciones,
               etiqueta: valor, nuevo: !d && !!nombreDest };
    }
  }

  const dest = cat.destinos.find(d => igual(d.nombre));
  if (dest) {
    return { tipo_jornada: 'ebs', destino_nombre: dest.nombre,
             municipio_id: dest.municipio_id || null, observaciones,
             etiqueta: dest.nombre };
  }
  // Destino que todavía no existe: se crea al aplicar.
  return { tipo_jornada: 'ebs', destino_nombre: valor, municipio_id: null,
           observaciones, etiqueta: valor, nuevo: true };
}

async function cargarPlantilla(input) {
  const archivo = input.files?.[0];
  input.value = '';                                  // permite recargar el mismo archivo
  if (!archivo) return;

  let filas;
  try {
    const libro = XLSX.read(await archivo.arrayBuffer(), { type: 'array' });
    const hoja = libro.Sheets['ITINERARIO'] || libro.Sheets[libro.SheetNames[0]];
    filas = XLSX.utils.sheet_to_json(hoja, { header: 1, blankrows: false, defval: '' });
  } catch (e) {
    return aviso('No se pudo leer el archivo: ' + e.message, 'mal', 'Archivo ilegible');
  }

  const iCab = filas.findIndex(f => String(f[0] ?? '').trim().toUpperCase() === 'PLACA');
  if (iCab < 0) {
    return aviso('No encontré la fila que empieza con PLACA. ¿Es la plantilla descargada?',
                 'mal', 'Formato no reconocido');
  }

  // Fechas ISO del encabezado, desde la tercera columna
  const cols = [];
  for (let c = 2; c < filas[iCab].length; c++) {
    const v = String(filas[iCab][c] ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) cols.push({ c, fecha: v });
  }
  if (!cols.length) {
    return aviso('La fila de PLACA no trae fechas en formato 2026-09-14.',
                 'mal', 'Formato no reconocido');
  }

  // Se recarga el itinerario del rango del archivo, no el de la pantalla
  const desde = cols[0].fecha, hasta = cols[cols.length - 1].fecha;
  const actual = await api(`/api/itinerario?desde=${desde}&hasta=${hasta}`);
  const porClave = {};
  actual.forEach(i => { porClave[i.fecha + '|' + i.vehiculo_id] = i; });

  const ops = [], avisos = [], bloqueadas = [];
  let sinCambio = 0;

  for (let r = iCab + 1; r < filas.length; r++) {
    const placa = String(filas[r][0] ?? '').trim().toUpperCase();
    if (!placa) continue;
    const veh = vehiculos.find(v => v.placa.toUpperCase() === placa);
    if (!veh) { avisos.push(`Placa desconocida, fila omitida: ${placa}`); continue; }

    for (const { c, fecha } of cols) {
      const nueva = interpretarCelda(filas[r][c]);
      const vieja = porClave[fecha + '|' + veh.id];

      if (vieja && vieja.trayectos_cerrados > 0) {
        const quiereCambio = !nueva
          || nueva.tipo_jornada !== vieja.tipo_jornada
          || (nueva.destino_nombre || '') !== (vieja.destino || '');
        if (quiereCambio) bloqueadas.push(`${placa} · ${fecha} (el conductor ya marcó)`);
        continue;
      }

      if (!nueva && vieja) {
        ops.push({ accion: 'borrar', id: vieja.id, placa, fecha,
                   antes: vieja.destino || TIPOS_JORNADA[vieja.tipo_jornada]?.et });
      } else if (nueva && !vieja) {
        ops.push({ accion: 'crear', fecha, vehiculo_id: veh.id,
                   conductor_id: veh.conductor_id || null,
                   tipo_jornada: nueva.tipo_jornada, municipio_id: nueva.municipio_id,
                   destino_nombre: nueva.destino_nombre,
                   observaciones: nueva.observaciones,
                   placa, despues: nueva.etiqueta, nuevo: nueva.nuevo });
      } else if (nueva && vieja) {
        const cambia = nueva.tipo_jornada !== vieja.tipo_jornada
          || (nueva.destino_nombre || '') !== (vieja.destino || '')
          || (nueva.observaciones || '') !== (vieja.observaciones || '');
        if (!cambia) { sinCambio++; continue; }
        ops.push({ accion: 'actualizar', id: vieja.id, fecha, vehiculo_id: veh.id,
                   tipo_jornada: nueva.tipo_jornada, municipio_id: nueva.municipio_id,
                   destino_nombre: nueva.destino_nombre,
                   observaciones: nueva.observaciones,
                   placa, antes: vieja.destino || TIPOS_JORNADA[vieja.tipo_jornada]?.et,
                   despues: nueva.etiqueta, nuevo: nueva.nuevo });
      }
    }
  }

  mostrarPrevia(ops, avisos, bloqueadas, sinCambio, desde, hasta);
}

function mostrarPrevia(ops, avisos, bloqueadas, sinCambio, desde, hasta) {
  const porAccion = a => ops.filter(o => o.accion === a);
  const crear = porAccion('crear'), actualizar = porAccion('actualizar'), borrar = porAccion('borrar');
  const destinosNuevos = [...new Set(ops.filter(o => o.nuevo).map(o => o.despues))];

  const lista = (titulo, arr, color, render) => arr.length ? `
    <div class="chk-sec" style="color:var(--${color})">${titulo} (${arr.length})</div>
    <div style="max-height:190px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r)">
      ${arr.map(render).join('')}
    </div>` : '';

  abrirModal('Vista previa de la carga', `
    <p style="font-size:.87rem;color:var(--text-soft);margin:0 0 .85rem">
      Del <b>${desde}</b> al <b>${hasta}</b>. Nada se ha guardado todavía.</p>

    <div class="previa-res">
      <div class="r" style="border-color:rgba(10,125,87,.3)"><b style="color:var(--verde)">${crear.length}</b>a crear</div>
      <div class="r" style="border-color:rgba(162,98,10,.3)"><b style="color:var(--ambar)">${actualizar.length}</b>a cambiar</div>
      <div class="r" style="border-color:rgba(194,46,36,.3)"><b style="color:var(--rojo)">${borrar.length}</b>a borrar</div>
      <div class="r"><b style="color:var(--muted)">${sinCambio}</b>sin cambio</div>
    </div>

    ${bloqueadas.length ? `<div class="nota avi" style="margin-bottom:.85rem">
      <b>${bloqueadas.length} día(s) no se tocarán</b> porque el conductor ya marcó salida.
      Cambiarlos descuadraría el contador de días y la liquidación.
      <div style="margin-top:.3rem;font-size:.78rem">${bloqueadas.slice(0, 6).map(esc).join('<br>')}
      ${bloqueadas.length > 6 ? `<br>y ${bloqueadas.length - 6} más` : ''}</div>
    </div>` : ''}

    ${avisos.length ? `<div class="nota avi" style="margin-bottom:.85rem">
      ${avisos.slice(0, 5).map(esc).join('<br>')}</div>` : ''}

    ${destinosNuevos.length ? `<div class="nota" style="margin-bottom:.85rem">
      Se crearán ${destinosNuevos.length} destino(s) nuevo(s):
      <b>${destinosNuevos.slice(0, 8).map(esc).join(', ')}</b>${destinosNuevos.length > 8 ? '…' : ''}
      <br><span style="font-size:.78rem">Revise que no sean errores de digitación de un destino que ya existe.</span>
    </div>` : ''}

    ${lista('Se van a crear', crear, 'verde', o => `<div class="previa-fila">
      <b class="placa">${esc(o.placa)}</b>
      <span>${esc(o.fecha)} · ${esc(o.despues)}</span></div>`)}

    ${lista('Van a cambiar', actualizar, 'ambar', o => `<div class="previa-fila">
      <b class="placa">${esc(o.placa)}</b>
      <span>${esc(o.fecha)} · <s style="color:var(--muted)">${esc(o.antes || 'vacío')}</s> → ${esc(o.despues)}</span></div>`)}

    ${lista('Se van a borrar', borrar, 'rojo', o => `<div class="previa-fila">
      <b class="placa">${esc(o.placa)}</b>
      <span>${esc(o.fecha)} · ${esc(o.antes || '')}</span></div>`)}

    ${!ops.length ? '<div class="vacio">El archivo no trae ningún cambio respecto a lo que ya está registrado.</div>' : ''}`,
    `<button class="btn sec" onclick="cerrarModal()">Cancelar</button>
     ${ops.length ? `<button class="btn" id="pv-btn" onclick="aplicarPrevia()">Aplicar ${ops.length} cambio(s)</button>` : ''}`);

  window._opsPrevia = ops;
}

async function aplicarPrevia() {
  const ops = window._opsPrevia || [];
  const btn = $('#pv-btn'); btn.disabled = true; btn.textContent = 'Aplicando...';
  try {
    const r = await api('/api/itinerario/lote', {
      metodo: 'POST',
      cuerpo: {
        operaciones: ops.map(({ placa, antes, despues, nuevo, ...o }) => o),
      },
    });
    cerrarModal();
    const partes = [];
    if (r.creadas) partes.push(`${r.creadas} creada(s)`);
    if (r.actualizadas) partes.push(`${r.actualizadas} cambiada(s)`);
    if (r.borradas) partes.push(`${r.borradas} borrada(s)`);
    aviso(partes.join(' · ') || 'Sin cambios', 'ok', 'Itinerario actualizado');
    if (r.errores?.length) {
      aviso(`${r.errores.length} fila(s) no se pudieron aplicar: ${r.errores[0].motivo}`,
            'avi', 'Con reparos');
    }
    cat = await api('/api/catalogos');
    verItinerario();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo aplicar');
    btn.disabled = false; btn.textContent = 'Aplicar';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BANNER INSTITUCIONAL
// ═══════════════════════════════════════════════════════════════════════════

/** Se pide sin sesión: aparece también en la pantalla de ingreso. */
async function cargarBanner() {
  try {
    const r = await (await fetch(API + '/api/banner')).json();
    banner = r && !r.vacio && r.datos ? r : null;
    await guardarEnCaja('banner', banner);
  } catch {
    banner = await leerDeCaja('banner');     // sin señal, el último que se vio
  }
  pintarBanner();
}

const bannerUrl = () => banner ? `data:${banner.mime};base64,${banner.datos}` : null;

function pintarBanner() {
  const url = bannerUrl();
  for (const id of ['banner-ingreso', 'banner-cabecera']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = url ? `<img src="${url}" alt="Encabezado institucional">` : '';
    el.style.display = url ? '' : 'none';
  }
}

/**
 * Redimensiona la imagen a 2000×289 antes de enviarla.
 *
 * Se hace en el navegador y no en el servidor porque así el archivo que viaja
 * ya va comprimido: una foto de 4 MB se convierte en unos 150 KB y la base no
 * termina guardando imágenes enormes que nadie va a ver a ese tamaño.
 */
function prepararBanner(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer el archivo'));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('El archivo no es una imagen válida'));
      img.onload = () => {
        const lienzo = document.createElement('canvas');
        lienzo.width = BANNER_ANCHO; lienzo.height = BANNER_ALTO;
        const ctx = lienzo.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, BANNER_ANCHO, BANNER_ALTO);

        // Se encaja la imagen completa sin deformarla; si no calza la
        // proporción, queda margen blanco a los lados.
        const escala = Math.min(BANNER_ANCHO / img.width, BANNER_ALTO / img.height);
        const an = img.width * escala, al = img.height * escala;
        ctx.drawImage(img, (BANNER_ANCHO - an) / 2, (BANNER_ALTO - al) / 2, an, al);

        let url = lienzo.toDataURL('image/webp', 0.9);
        if (!url.startsWith('data:image/webp')) url = lienzo.toDataURL('image/jpeg', 0.9);
        const coma = url.indexOf(',');
        resolve({
          mime: url.slice(5, url.indexOf(';')),
          datos: url.slice(coma + 1),
          ancho: BANNER_ANCHO, alto: BANNER_ALTO,
          original: { ancho: img.width, alto: img.height },
        });
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

async function subirBanner(input) {
  const archivo = input.files?.[0];
  input.value = '';
  if (!archivo) return;
  try {
    const b = await prepararBanner(archivo);
    const kb = Math.round(b.datos.length * 3 / 4 / 1024);
    await api('/api/banner', { metodo: 'PUT', cuerpo: b });
    banner = { mime: b.mime, datos: b.datos };
    pintarBanner();
    const aviso_ = b.original.ancho !== BANNER_ANCHO || b.original.alto !== BANNER_ALTO
      ? ` (venía en ${b.original.ancho}×${b.original.alto}, se ajustó)` : '';
    aviso(`Banner actualizado, ${kb} KB${aviso_}`, 'ok', 'Listo');
    verAjustes();
  } catch (e) {
    aviso(e.message, 'mal', 'No se pudo subir');
  }
}

async function quitarBanner() {
  try {
    await api('/api/banner', { metodo: 'DELETE' });
    banner = null; pintarBanner(); verAjustes();
    aviso('Banner quitado', 'ok');
  } catch (e) { aviso(e.message, 'mal'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF DEL ITINERARIO
//
// Todo el período en una sola hoja. Como 31 columnas no caben en una carta, el
// tamaño del papel se escoge según cuántos días haya, en lugar de encoger la
// letra hasta volverla ilegible. Al imprimir, "ajustar a la página" hace el resto.
// ═══════════════════════════════════════════════════════════════════════════

const COLORES_PDF = {
  ebs:             [30, 90, 168],
  jornada:         [109, 58, 173],
  vacunacion:      [10, 125, 87],
  disponible:      [117, 130, 143],
  traslado_ciudad: [162, 98, 10],
  administrativo:  [150, 150, 150],
};

async function descargarPDF() {
  const { jsPDF } = window.jspdf;
  const dias = Array.from({ length: itinDias }, (_, i) => nDias(itinDesde, i));
  const activos = vehiculos.filter(v => v.activo !== 0);
  const hasta = dias[dias.length - 1];

  // Medidas en milímetros
  const colVeh = 34, colDia = Math.max(19, Math.min(30, 260 / dias.length));
  const margen = 8;
  const altoFila = 11, altoCab = 11;
  const altoTitulo = 13, altoLeyenda = 12;
  const ancho = margen * 2 + colVeh + colDia * dias.length;

  // El banner va al margen izquierdo, alineado con el borde de la tabla y del
  // título, y acotado a 110 mm: a lo ancho de la hoja tapaba media página y
  // empujaba la tabla fuera del papel.
  const anchoBanner = Math.min(110, ancho - margen * 2);
  const altoBanner = banner ? anchoBanner * BANNER_ALTO / BANNER_ANCHO + 4 : 0;

  // La altura se calcula con las mismas medidas con las que luego se dibuja.
  // Cuando no coinciden, las últimas filas caen fuera de la página y
  // desaparecen sin aviso: es exactamente lo que pasaba antes.
  const alto = margen * 2 + altoBanner + altoTitulo + altoCab
             + altoFila * activos.length + altoLeyenda;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [ancho, alto] });
  let y = margen;

  if (banner) {
    doc.addImage(bannerUrl(), margen, y,
                 anchoBanner, anchoBanner * BANNER_ALTO / BANNER_ANCHO);
    y += altoBanner;
  }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text('ITINERARIO DE FLOTA — MISIÓN MÉDICA', margen, y + 4);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.setTextColor(90);
  doc.text(`ESE Hospital Regional Noroccidental · del ${itinDesde} al ${hasta}`, margen, y + 9);
  doc.text(`Generado el ${new Date().toLocaleString('es-CO')} por ${sesion.nombre}`,
           ancho - margen, y + 9, { align: 'right' });
  doc.setTextColor(0);
  y += altoTitulo;

  // ── Encabezado de la tabla ──
  const x0 = margen;
  doc.setFillColor(240, 243, 246);
  doc.rect(x0, y, colVeh + colDia * dias.length, altoCab, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
  doc.text('VEHÍCULO', x0 + 2, y + 6.5);
  dias.forEach((f, i) => {
    const x = x0 + colVeh + i * colDia;
    const esHoy = f === hoy();
    if (esHoy) { doc.setFillColor(222, 233, 246); doc.rect(x, y, colDia, altoCab, 'F'); }
    doc.setFontSize(6);
    doc.setTextColor(esHoy ? 30 : 110, esHoy ? 90 : 110, esHoy ? 168 : 110);
    doc.text(diaSemana(f).slice(0, 3).toUpperCase(), x + colDia / 2, y + 4, { align: 'center' });
    doc.setFontSize(8); doc.setTextColor(esHoy ? 30 : 0, esHoy ? 90 : 0, esHoy ? 168 : 0);
    doc.text(f.slice(8) + '/' + f.slice(5, 7), x + colDia / 2, y + 8.6, { align: 'center' });
  });
  doc.setTextColor(0);
  y += altoCab;

  // ── Filas ──
  const porClave = {};
  itinDatos.forEach(i => { porClave[i.fecha + '|' + i.vehiculo_id] = i; });

  activos.forEach((v, fila) => {
    const yf = y + fila * altoFila;
    if (fila % 2) { doc.setFillColor(250, 251, 252); doc.rect(x0, yf, colVeh + colDia * dias.length, altoFila, 'F'); }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    doc.text(v.placa, x0 + 2, yf + 4.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(5.6); doc.setTextColor(110);
    doc.text(doc.splitTextToSize(v.conductor_actual?.trim() || 'Sin conductor', colVeh - 3)[0] || '',
             x0 + 2, yf + 8.2);
    doc.setTextColor(0);

    dias.forEach((f, i) => {
      const x = x0 + colVeh + i * colDia;
      const it = porClave[f + '|' + v.id];
      if (!it) return;
      const col = COLORES_PDF[it.tipo_jornada] || COLORES_PDF.ebs;

      doc.setFillColor(col[0], col[1], col[2]);
      doc.rect(x + 0.8, yf + 1, 1.1, altoFila - 2, 'F');           // barra de color

      const titulo = it.tipo_jornada === 'disponible' ? 'DISPONIBLE'
        : (it.destino || TIPOS_JORNADA[it.tipo_jornada]?.et || '');

      // Se busca el mayor tamaño con el que el nombre quepa en dos renglones
      // sin partir palabras: un "CAPITANLARG / O" es peor que letra más chica.
      doc.setFont('helvetica', 'bold');
      let tam = 6.2, lineas;
      for (const t of [6.2, 5.6, 5, 4.5, 4]) {
        doc.setFontSize(t);
        lineas = doc.splitTextToSize(titulo, colDia - 4);
        tam = t;
        const parteSana = lineas.every(l => !l.endsWith('-')) &&
          lineas.join('').length >= titulo.replace(/\s/g, '').length;
        if (lineas.length <= 2 && parteSana) break;
      }
      doc.setFontSize(tam);
      lineas = lineas.slice(0, 2);
      lineas.forEach((ln, k) => doc.text(ln, x + 3, yf + 4 + k * (tam * 0.46)));

      doc.setFont('helvetica', 'normal'); doc.setFontSize(4.8);
      doc.setTextColor(col[0], col[1], col[2]);
      const pie = it.tipo_jornada === 'disponible'
        ? (it.municipio || '') : (TIPOS_JORNADA[it.tipo_jornada]?.et || '');
      doc.text(doc.splitTextToSize(pie, colDia - 4)[0] || '', x + 3, yf + altoFila - 2.2);
      doc.setTextColor(0);

      if (it.trayectos_cerrados > 0) {                              // ejecutado
        doc.setFillColor(10, 125, 87);
        doc.circle(x + colDia - 2.6, yf + 2.6, 0.8, 'F');
      }
    });
  });

  // ── Marco y líneas ──
  const yTabla = y - altoCab, hTabla = altoCab + altoFila * activos.length;
  doc.setDrawColor(215, 221, 228); doc.setLineWidth(0.15);
  for (let i = 0; i <= dias.length; i++) {
    const x = x0 + colVeh + i * colDia;
    doc.line(x, yTabla, x, yTabla + hTabla);
  }
  for (let f = 0; f <= activos.length; f++) {
    doc.line(x0, y + f * altoFila, x0 + colVeh + colDia * dias.length, y + f * altoFila);
  }
  doc.setDrawColor(150, 160, 172); doc.setLineWidth(0.3);
  doc.rect(x0, yTabla, colVeh + colDia * dias.length, hTabla);
  doc.line(x0, yTabla + altoCab, x0 + colVeh + colDia * dias.length, yTabla + altoCab);
  doc.line(x0 + colVeh, yTabla, x0 + colVeh, yTabla + hTabla);

  // ── Leyenda ──
  let yl = y + altoFila * activos.length + 6, xl = x0;
  doc.setFontSize(6); doc.setFont('helvetica', 'normal');
  for (const [tipo, t] of Object.entries(TIPOS_JORNADA)) {
    const c = COLORES_PDF[tipo] || [120, 120, 120];
    doc.setFillColor(c[0], c[1], c[2]);
    doc.rect(xl, yl - 2, 2.4, 2.4, 'F');
    doc.text(t.et, xl + 3.4, yl);
    xl += doc.getTextWidth(t.et) + 10;
  }
  doc.setFillColor(10, 125, 87); doc.circle(xl + 1, yl - 0.8, 0.8, 'F');
  doc.text('ejecutado (el conductor marcó salida)', xl + 3.4, yl);

  // Red de seguridad: si el cálculo y el dibujo se desalinean, se avisa en vez
  // de entregar un PDF al que le faltan vehículos sin que nadie lo note.
  const yFinal = y + altoFila * activos.length + altoLeyenda;
  if (yFinal > alto + 0.5) {
    aviso(`El PDF quedó ${Math.ceil(yFinal - alto)} mm corto; avise para corregirlo.`,
          'mal', 'Revise el PDF');
  }

  doc.save(`itinerario_${itinDesde}_a_${hasta}.pdf`);
  aviso(`PDF generado con ${activos.length} vehículos`, 'ok', 'Listo');
}
