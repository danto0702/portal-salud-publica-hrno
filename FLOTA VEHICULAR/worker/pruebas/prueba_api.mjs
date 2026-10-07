/**
 * Prueba de extremo a extremo de la API de Flota HRNO.
 * Ejecuta el Worker real contra una base SQLite en memoria y recorre el flujo
 * completo: instalar, ingresar, crear usuarios de los tres roles, adjudicar un
 * desplazamiento, marcar salida y llegada, checklist y dashboard.
 *
 *   node pruebas/prueba_api.mjs
 */
import fs from 'node:fs';
import { crearD1 } from './d1_local.js';
import worker from '../src/index.js';

const db = crearD1();
const esquema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const semilla = fs.readFileSync(new URL('../seed_catalogos.sql', import.meta.url), 'utf8');

// A PROPÓSITO se siembra la base SIN la tabla fuera_servicio, para ejercitar la
// misma situación en que está la base de producción: se creó antes de que esa
// tabla existiera, y quien despliega no tiene terminal para ejecutar un CREATE
// TABLE — pega el Worker en el editor web de Cloudflare y ya. El Worker la crea
// solo en el primer uso (asegurarEsquema en src/lib.js). Si eso se rompiera,
// toda la sección de días fuera de servicio fallaría aquí antes que en Ocaña.
const esquemaViejo = esquema
  .replace(/CREATE TABLE fuera_servicio[\s\S]*?\n\);\n/, '')
  .replace(/CREATE INDEX idx_fs_[^;]*;\n/g, '');
if (esquemaViejo === esquema) throw new Error('no se pudo quitar fuera_servicio del esquema');
db.exec(esquemaViejo);
db.exec(semilla);

const existeTabla = n => !!db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name = ?").bind(n).first();

const env = {
  DB: db,
  ORIGENES_PERMITIDOS: 'https://danto0702.github.io',
  HORAS_SESION: '12',
  CLAVE_ADMIN_INICIAL: 'InstalacionHRNO2026',
};

let fallos = 0, pruebas = 0;

async function api(metodo, ruta, cuerpo, token) {
  const cabeceras = { 'Content-Type': 'application/json', Origin: 'https://danto0702.github.io' };
  if (token) cabeceras.Authorization = `Bearer ${token}`;
  const req = new Request('https://flota.test' + ruta, {
    method: metodo, headers: cabeceras,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const res = await worker.fetch(req, env);
  return { estado: res.status, datos: await res.json() };
}

function verificar(nombre, condicion, detalle) {
  pruebas++;
  if (condicion) { console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.log(`  ✗ ${nombre}`, detalle !== undefined ? JSON.stringify(detalle) : ''); }
}

// El Worker calcula el día operativo en hora de Colombia (UTC-5), no en la del
// equipo que corre la prueba. Si aquí se usara la hora local, entre las 7 de la
// tarde y la medianoche de Colombia la prueba pediría el día siguiente y no
// encontraría nada. Misma cuenta que hoyISO() en src/lib.js.
const hoy = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
// JPEG de 1x1: suficiente para ejercitar la ruta de fotografías
const FOTO = { mime: 'image/jpeg', datos: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==' };

console.log('\n── Salud e instalación ───────────────────────────────────────');
verificar('la base arranca SIN fuera_servicio, como la de producción',
  !existeTabla('fuera_servicio'));
let r = await api('GET', '/api/fuera-servicio');
verificar('una base vieja no revienta al preguntar por los días parados',
  r.estado === 401, r.estado);          // 401: sin sesión, pero llegó a la ruta

r = await api('GET', '/api/salud');
verificar('la sonda de salud responde', r.estado === 200 && r.datos.ok, r.datos);
verificar('hay rutas registradas', r.datos.rutas > 30, r.datos.rutas);

r = await api('POST', '/api/instalar', { clave_instalacion: 'equivocada' });
verificar('instalar rechaza la clave incorrecta', r.estado === 403, r.datos);

r = await api('POST', '/api/instalar', {
  clave_instalacion: 'InstalacionHRNO2026', usuario: 'danilo', clave: 'ClaveInicial2026',
});
verificar('instala el primer usuario principal', r.estado === 200 && r.datos.ok, r.datos);

r = await api('POST', '/api/instalar', { clave_instalacion: 'InstalacionHRNO2026' });
verificar('instalar queda cerrado para siempre', r.estado === 409, r.datos);

console.log('\n── Autenticación ─────────────────────────────────────────────');
r = await api('POST', '/api/auth/login', { usuario: 'danilo', clave: 'incorrecta' });
verificar('rechaza clave incorrecta', r.estado === 401, r.datos);

r = await api('POST', '/api/auth/login', { usuario: 'fantasma', clave: 'loquesea' });
verificar('no revela si el usuario existe', r.estado === 401, r.datos);

r = await api('POST', '/api/auth/login', { usuario: 'danilo', clave: 'ClaveInicial2026' });
verificar('ingresa el usuario principal', r.estado === 200 && !!r.datos.token, r.datos);
verificar('exige cambio de clave inicial', r.datos.usuario.debe_cambiar_clave === true);
const tokenPrincipal = r.datos.token;

r = await api('GET', '/api/vehiculos');
verificar('sin token la API responde 401', r.estado === 401, r.datos);

console.log('\n── Usuarios y roles ──────────────────────────────────────────');
r = await api('POST', '/api/personas', {
  nombres: 'JEISON OMAR', apellidos: 'NAVARRO', numero_doc: '1091665252',
  telefono: '3206167920', municipio_id: 1, es_conductor: true,
}, tokenPrincipal);
verificar('crea una persona conductora', r.estado === 200 && r.datos.id, r.datos);
const personaConductor = r.datos.id;

r = await api('POST', '/api/usuarios', {
  usuario: 'coordina', clave: 'Coordinacion2026', rol: 'coordinacion',
}, tokenPrincipal);
verificar('el principal crea un usuario de coordinación', r.estado === 200, r.datos);

r = await api('POST', '/api/usuarios', {
  usuario: 'jnavarro', clave: 'Conductor2026', rol: 'conductor', persona_id: personaConductor,
}, tokenPrincipal);
verificar('el principal crea un usuario conductor', r.estado === 200, r.datos);

r = await api('POST', '/api/usuarios', { usuario: 'x', clave: 'Clave123456', rol: 'inventado' },
              tokenPrincipal);
verificar('rechaza un rol inexistente', r.estado === 400, r.datos);

const tCoord = (await api('POST', '/api/auth/login',
  { usuario: 'coordina', clave: 'Coordinacion2026' })).datos.token;
const tCond = (await api('POST', '/api/auth/login',
  { usuario: 'jnavarro', clave: 'Conductor2026' })).datos.token;
verificar('ingresan coordinación y conductor', !!tCoord && !!tCond);

r = await api('POST', '/api/usuarios', { usuario: 'colado', clave: 'Clave123456', rol: 'principal' },
              tCoord);
verificar('coordinación NO puede crear usuarios', r.estado === 403, r.datos);

r = await api('POST', '/api/usuarios', { usuario: 'colado2', clave: 'Clave123456', rol: 'principal' },
              tCond);
verificar('el conductor NO puede crear usuarios', r.estado === 403, r.datos);

r = await api('GET', '/api/auditoria', null, tCoord);
verificar('coordinación NO ve la auditoría completa', r.estado === 403, r.datos);

console.log('\n── Vínculo conductor ↔ persona ───────────────────────────────');
// Este era el fallo real: una cuenta de conductor sin persona entra pero no ve
// nada, porque el itinerario se busca por persona y no por usuario.
r = await api('POST', '/api/usuarios',
  { usuario: 'suelto', clave: 'Conductor2026', rol: 'conductor' }, tokenPrincipal);
verificar('no deja crear un conductor sin persona vinculada', r.estado === 400, r.datos);
verificar('y explica por qué', /itinerario/i.test(r.datos.error || ''), r.datos.error);

r = await api('POST', '/api/usuarios',
  { usuario: 'coord2', clave: 'Coordina2026', rol: 'coordinacion' }, tokenPrincipal);
verificar('coordinación sí puede ir sin persona', r.estado === 200, r.datos);

r = await api('PUT', `/api/usuarios/${r.datos.id}`, { rol: 'conductor' }, tokenPrincipal);
verificar('tampoco deja convertirla en conductor sin persona', r.estado === 400, r.datos);

r = await api('GET', '/api/usuarios', null, tokenPrincipal);
verificar('el listado marca las cuentas sin vínculo',
  r.datos.every(u => u.sin_persona === 0 || u.rol === 'conductor'), r.datos.length);

// Una cuenta sin persona debe decir por qué, no mostrar un día vacío
const tSinP = (await api('POST', '/api/auth/login',
  { usuario: 'coord2', clave: 'Coordina2026' })).datos.token;
r = await api('GET', '/api/mi-dia', null, tSinP);
verificar('mi-día avisa que la cuenta no está vinculada',
  r.estado === 200 && r.datos.sin_persona === true, r.datos);

console.log('\n── Parámetros visibles para el conductor ─────────────────────');
r = await api('GET', '/api/parametros', null, tCond);
verificar('el conductor puede leer los parámetros', r.estado === 200 && r.datos.length > 0,
  r.datos.length);
verificar('incluye la configuración de la app de fotos',
  r.datos.some(p => p.clave === 'app_foto_activa'), r.datos.map(p => p.clave).slice(0, 8));
verificar('pero no los correos de alertas',
  !r.datos.some(p => p.clave === 'correo_alertas'), r.datos.map(p => p.clave));

r = await api('PUT', '/api/parametros/app_foto_nombre', { valor: 'OtraApp' }, tCond);
verificar('y no puede modificarlos', r.estado === 403, r.datos);

console.log('\n── Sello de cambios ──────────────────────────────────────────');
r = await api('GET', '/api/sello', null, tCoord);
verificar('devuelve un sello', r.estado === 200 && !!r.datos.sello, r.datos);
const selloAntes = r.datos.sello;

r = await api('GET', '/api/sello', null, tCoord);
verificar('sin cambios, el sello es el mismo', r.datos.sello === selloAntes, r.datos.sello);

await api('POST', '/api/personas', { nombres: 'PARA SELLO' }, tokenPrincipal);
r = await api('GET', '/api/sello', null, tCoord);
verificar('tras un cambio, el sello cambia', r.datos.sello !== selloAntes,
  { antes: selloAntes, despues: r.datos.sello });

r = await api('GET', '/api/sello', null, tCond);
verificar('el conductor también puede consultarlo', r.estado === 200, r.datos);

console.log('\n── Vehículos ─────────────────────────────────────────────────');
r = await api('POST', '/api/vehiculos', {
  placa: 'GEU-665', tipo: 'camioneta', municipio_base_id: 1,
  propiedad: 'contratista', contratista: 'TRANSPORTES DEL CATATUMBO',
  valor_dia: 180000,
}, tokenPrincipal);
verificar('el principal crea un vehículo', r.estado === 200 && r.datos.id, r.datos);
const vehiculo = r.datos.id;

r = await api('POST', '/api/vehiculos', { placa: 'GEU-665' }, tokenPrincipal);
verificar('rechaza placa duplicada', r.estado === 409, r.datos);

r = await api('POST', '/api/vehiculos', { placa: 'ZZZ-999' }, tCoord);
verificar('coordinación NO crea vehículos', r.estado === 403, r.datos);

console.log('\n── Conductor predeterminado ──────────────────────────────────');
r = await api('GET', '/api/vehiculos', null, tokenPrincipal);
verificar('un vehículo nuevo no trae conductor asignado',
  r.datos[0] && r.datos[0].conductor_id == null, r.datos[0] && r.datos[0].conductor_id);

r = await api('PUT', `/api/vehiculos/${vehiculo}`, { conductor_id: personaConductor }, tokenPrincipal);
verificar('el principal asigna el conductor predeterminado', r.estado === 200, r.datos);

r = await api('GET', '/api/vehiculos', null, tokenPrincipal);
verificar('el vehículo devuelve su conductor', r.datos[0].conductor_id === personaConductor, r.datos[0]);
verificar('y también su nombre para mostrarlo',
  (r.datos[0].conductor_actual || '').includes('JEISON'), r.datos[0].conductor_actual);

// Reasignar a otra persona debe cerrar la anterior, no borrarla
r = await api('POST', '/api/personas', { nombres: 'RELEVO', es_conductor: true }, tokenPrincipal);
const relevo = r.datos.id;
await api('PUT', `/api/vehiculos/${vehiculo}`, { conductor_id: relevo }, tokenPrincipal);
r = await api('GET', '/api/vehiculos', null, tokenPrincipal);
verificar('al reasignar, queda el conductor nuevo', r.datos[0].conductor_id === relevo, r.datos[0]);

r = await api('GET', '/api/auditoria', null, tokenPrincipal);
verificar('el cambio de conductor queda en auditoría',
  r.datos.some(a => a.entidad === 'asignaciones'), r.datos.slice(0, 3));

// Dejar sin conductor
await api('PUT', `/api/vehiculos/${vehiculo}`, { conductor_id: null }, tokenPrincipal);
r = await api('GET', '/api/vehiculos', null, tokenPrincipal);
verificar('se puede dejar el vehículo sin conductor', r.datos[0].conductor_id == null, r.datos[0]);

// Restaurar para las pruebas siguientes
await api('PUT', `/api/vehiculos/${vehiculo}`, { conductor_id: personaConductor }, tokenPrincipal);

r = await api('PUT', `/api/vehiculos/${vehiculo}`, { conductor_id: relevo }, tCoord);
verificar('coordinación NO cambia el conductor del vehículo', r.estado === 403, r.datos);

r = await api('POST', '/api/vehiculos',
  { placa: 'ABC-123', conductor_id: personaConductor }, tokenPrincipal);
const veh2 = r.datos.id;
r = await api('GET', '/api/vehiculos', null, tokenPrincipal);
verificar('también se puede asignar al crear el vehículo',
  r.datos.find(v => v.id === veh2)?.conductor_id === personaConductor,
  r.datos.find(v => v.id === veh2));

console.log('\n── Itinerario y destinos vivos ───────────────────────────────');
r = await api('POST', '/api/itinerario', {
  fecha: hoy, vehiculo_id: vehiculo, conductor_id: personaConductor,
  municipio_id: 1, destino_nombre: 'hoyo pilón', tipo_jornada: 'ebs',
}, tCoord);
verificar('coordinación adjudica un desplazamiento', r.estado === 200 && r.datos.id, r.datos);
const itinerario = r.datos.id;
verificar('reutiliza el destino ya existente del catálogo', r.datos.destino_id === 8, r.datos);

r = await api('POST', '/api/itinerario', {
  fecha: hoy, vehiculo_id: vehiculo, municipio_id: 1, destino_nombre: 'OTRA VEREDA',
}, tCoord);
verificar('detecta choque: dos programaciones el mismo día', r.estado === 400, r.datos);

r = await api('POST', '/api/itinerario', {
  fecha: '2026-12-01', vehiculo_id: vehiculo, municipio_id: 3,
  destino_nombre: 'VEREDA NUEVA SIN CATÁLOGO',
}, tCoord);
verificar('crea un destino nuevo sobre la marcha', r.estado === 200 && r.datos.destino_id > 17, r.datos);

r = await api('PUT', `/api/itinerario/${itinerario}`, {
  tipo_jornada: 'vacunacion', motivo: 'Se reprogramó por jornada PAI',
}, tCoord);
verificar('coordinación modifica el itinerario', r.estado === 200, r.datos);

r = await api('GET', `/api/itinerario/${itinerario}/cambios`, null, tCoord);
verificar('el cambio queda en el historial visible', r.estado === 200 && r.datos.length === 1, r.datos);
verificar('el historial dice quién y qué cambió',
  r.datos[0] && r.datos[0].campo === 'tipo_jornada' &&
  r.datos[0].valor_antes === 'ebs' && r.datos[0].valor_despues === 'vacunacion' &&
  r.datos[0].usuario === 'coordina', r.datos[0]);

r = await api('PUT', `/api/itinerario/${itinerario}`, { tipo_jornada: 'ebs' }, tCond);
verificar('el conductor NO modifica el itinerario', r.estado === 403, r.datos);

console.log('\n── Predeterminados ───────────────────────────────────────────');
r = await api('POST', '/api/predeterminados', {
  nombre: 'EBS Santa Inés', tipo_jornada: 'ebs', municipio_id: 3,
  destino_nombre: 'SANTA INÉS', observaciones: 'Ruta habitual',
}, tCoord);
verificar('coordinación crea un predeterminado', r.estado === 200 && r.datos.id, r.datos);
const pred = r.datos.id;

r = await api('GET', '/api/predeterminados', null, tCond);
verificar('el conductor puede leerlos', r.estado === 200 && r.datos.length === 1, r.datos);
verificar('trae el destino resuelto', r.datos[0].destino === 'SANTA INÉS', r.datos[0]);

r = await api('POST', '/api/itinerario', {
  fecha: '2026-11-03', vehiculo_id: vehiculo, predeterminado_id: pred,
}, tCoord);
verificar('adjudicar con un predeterminado', r.estado === 200, r.datos);
const itPred = r.datos.id;

r = await api('GET', '/api/itinerario?desde=2026-11-03&hasta=2026-11-03', null, tCoord);
verificar('el predeterminado llenó tipo, municipio y destino',
  r.datos[0] && r.datos[0].tipo_jornada === 'ebs' && r.datos[0].destino === 'SANTA INÉS'
  && r.datos[0].municipio_id === 3, r.datos[0]);

r = await api('GET', '/api/predeterminados', null, tCoord);
verificar('cuenta cuántas veces se ha usado', r.datos[0].veces_usado === 1, r.datos[0]);

r = await api('DELETE', `/api/predeterminados/${pred}`, null, tCoord);
verificar('coordinación NO borra predeterminados', r.estado === 403, r.datos);
r = await api('DELETE', `/api/predeterminados/${pred}`, null, tokenPrincipal);
verificar('el administrador sí, y solo lo desactiva', r.estado === 200, r.datos);
r = await api('GET', '/api/predeterminados', null, tCoord);
verificar('desactivado deja de aparecer', r.datos.length === 0, r.datos);

console.log('\n── Mover y duplicar ──────────────────────────────────────────');
r = await api('POST', '/api/itinerario/mover', {
  id: itPred, fecha: '2026-11-04', vehiculo_id: vehiculo,
}, tCoord);
verificar('mueve a un día libre', r.estado === 200 && !r.datos.intercambio, r.datos);

r = await api('GET', '/api/itinerario?desde=2026-11-03&hasta=2026-11-04', null, tCoord);
verificar('quedó solo en el día nuevo',
  r.datos.length === 1 && r.datos[0].fecha === '2026-11-04', r.datos.map(x => x.fecha));

r = await api('GET', `/api/itinerario/${itPred}/cambios`, null, tCoord);
verificar('el movimiento queda en el historial',
  r.datos.some(c => c.campo === 'fecha' && c.valor_despues === '2026-11-04'), r.datos);

r = await api('POST', '/api/itinerario/mover', {
  id: itPred, fecha: '2026-11-05', vehiculo_id: vehiculo, duplicar: true,
}, tCoord);
verificar('duplica en otro día', r.estado === 200 && r.datos.duplicado, r.datos);
const itDup = r.datos.id;

r = await api('GET', '/api/itinerario?desde=2026-11-04&hasta=2026-11-05', null, tCoord);
verificar('ahora hay dos, con el mismo destino',
  r.datos.length === 2 && r.datos[0].destino === r.datos[1].destino,
  r.datos.map(x => `${x.fecha}:${x.destino}`));

r = await api('POST', '/api/itinerario/mover', {
  id: itPred, fecha: '2026-11-05', vehiculo_id: vehiculo, duplicar: true,
}, tCoord);
verificar('no duplica sobre una celda ocupada', r.estado === 400, r.datos);

// Intercambio: las dos existentes cambian de lugar
r = await api('POST', '/api/itinerario/mover', {
  id: itPred, fecha: '2026-11-05', vehiculo_id: vehiculo,
}, tCoord);
verificar('mover sobre celda ocupada intercambia', r.estado === 200 && r.datos.intercambio, r.datos);

r = await api('GET', '/api/itinerario?desde=2026-11-04&hasta=2026-11-05', null, tCoord);
const porFecha = Object.fromEntries(r.datos.map(x => [x.fecha, x.id]));
verificar('cada una quedó en el lugar de la otra',
  porFecha['2026-11-05'] === itPred && porFecha['2026-11-04'] === itDup, porFecha);
verificar('ninguna se perdió en el intercambio', r.datos.length === 2, r.datos.length);

console.log('\n── Borrado definitivo ────────────────────────────────────────');
r = await api('DELETE', `/api/itinerario/${itDup}?definitivo=1`, null, tCoord);
verificar('coordinación NO borra definitivamente', r.estado === 403, r.datos);

r = await api('DELETE', `/api/itinerario/${itDup}`, { motivo: 'prueba' }, tCoord);
verificar('coordinación sí puede cancelar', r.estado === 200 && r.datos.borrado === false, r.datos);

r = await api('DELETE', `/api/itinerario/${itPred}?definitivo=1`, null, tokenPrincipal);
verificar('el administrador borra definitivamente', r.estado === 200 && r.datos.borrado, r.datos);

r = await api('GET', '/api/itinerario?desde=2026-11-04&hasta=2026-11-05', null, tCoord);
verificar('el borrado desaparece de verdad', r.datos.length === 1, r.datos.map(x => x.id));

console.log('\n── Carga por lote (plantilla de Excel) ───────────────────────');
r = await api('POST', '/api/itinerario/lote', {
  operaciones: [
    { accion: 'crear', fecha: '2026-12-10', vehiculo_id: vehiculo, municipio_id: 1,
      destino_nombre: 'LA LAGUNA', tipo_jornada: 'ebs' },
    { accion: 'crear', fecha: '2026-12-11', vehiculo_id: vehiculo, tipo_jornada: 'disponible' },
    { accion: 'crear', fecha: '2026-12-12', vehiculo_id: 999999, tipo_jornada: 'ebs' },
  ],
}, tCoord);
verificar('el lote crea lo válido', r.estado === 200 && r.datos.creadas === 2, r.datos);
verificar('y reporta la fila mala sin tumbar el resto',
  r.datos.errores.length === 1, r.datos.errores);

r = await api('GET', '/api/itinerario?desde=2026-12-10&hasta=2026-12-12', null, tCoord);
verificar('quedaron las dos en el itinerario', r.datos.length === 2, r.datos.length);
const idLote = r.datos.find(x => x.fecha === '2026-12-10').id;

r = await api('POST', '/api/itinerario/lote', {
  operaciones: [{ accion: 'actualizar', id: idLote, tipo_jornada: 'vacunacion',
                  municipio_id: 1, destino_nombre: 'HONDURAS' }],
}, tCoord);
verificar('el lote actualiza', r.estado === 200 && r.datos.actualizadas === 1, r.datos);

r = await api('GET', `/api/itinerario/${idLote}/cambios`, null, tCoord);
verificar('la actualización por lote deja historial',
  r.datos.some(c => c.motivo && c.motivo.includes('Excel')), r.datos);

r = await api('POST', '/api/itinerario/lote', {
  operaciones: [{ accion: 'borrar', id: idLote }],
}, tCoord);
verificar('el lote borra', r.estado === 200 && r.datos.borradas === 1, r.datos);

r = await api('POST', '/api/itinerario/lote', { operaciones: [] }, tCoord);
verificar('un lote vacío se rechaza', r.estado === 400, r.datos);

r = await api('POST', '/api/itinerario/lote', {
  operaciones: [{ accion: 'crear', fecha: '2027-01-05', vehiculo_id: vehiculo }],
}, tCond);
verificar('el conductor NO puede cargar lotes', r.estado === 403, r.datos);

console.log('\n── Marcación con GPS ─────────────────────────────────────────');
console.log('\n── Totales de dias programados ───────────────────────────────');
r = await api('GET', '/api/itinerario/resumen', null, tCoord);
verificar('coordinación puede pedir los totales', r.estado === 200, r.datos);
verificar('vienen agrupados por vehículo', Array.isArray(r.datos.vehiculos), r.datos);
{
  // El contador de la matriz contaba los días del período visible, así que
  // cambiaba al mover la ventana. Estos totales son de TODA la operación: pedir
  // un período no debe alterarlos.
  const unDia = await api('GET', `/api/itinerario/resumen?desde=${hoy}&hasta=${hoy}`, null, tCoord);
  const totalGeneral = r.datos.vehiculos.reduce((a, v) => a + v.dias, 0);
  const totalDelDia = unDia.datos.vehiculos.reduce((a, v) => a + v.dias, 0);
  verificar('sin fechas cuenta más que acotado a un solo día',
    totalGeneral > totalDelDia, `${totalGeneral} vs ${totalDelDia}`);
  const uno = r.datos.vehiculos[0];
  verificar('los días con salida nunca superan el total de días',
    r.datos.vehiculos.every(v => v.con_salida <= v.dias), JSON.stringify(uno));
  verificar('trae el primer y el último día programado',
    !!(uno.primera && uno.ultima), JSON.stringify(uno));
}
r = await api('GET', '/api/itinerario/resumen', null, tCond);
verificar('un conductor NO puede pedir los totales de toda la flota',
  r.estado === 403, r.datos);

console.log('\n── Itinerario del conductor ──────────────────────────────────');
r = await api('GET', '/api/mi-itinerario?dias=15', null, tCond);
verificar('el conductor puede consultar su itinerario', r.estado === 200, r.datos);
verificar('viene la lista de días', Array.isArray(r.datos.dias), r.datos);

// Lo esencial: el filtro por conductor lo hace el SERVIDOR. Si un conductor
// pudiera ver la programación de sus compañeros sería una fuga de datos, y
// filtrar en la pantalla no sirve: basta con pedir la dirección a mano.
{
  const placas = [...new Set(r.datos.dias.map(d => d.placa))];
  verificar('solo ve la programación de su propio vehículo',
    placas.length <= 1, placas.join(', '));
  const suyos = r.datos.dias.every(d => d.destino !== undefined);
  verificar('cada día trae su destino', suyos);
}

r = await api('GET', '/api/mi-itinerario?dias=999', null, tCond);
verificar('un número de días disparatado no tumba la consulta', r.estado === 200, r.datos);

r = await api('GET', '/api/mi-dia', null, tCond);
verificar('el conductor ve su programación de hoy',
  r.estado === 200 && r.datos.itinerario && r.datos.itinerario.placa === 'GEU-665', r.datos);

// Campos obligatorios: primero se comprueba que falten los rechaza
r = await api('POST', '/api/trayectos/salida',
  { municipio_id: 1, lugar: 'BASE', num_tripulantes: 4, tripulantes: 'A, B', foto: FOTO }, tCond);
verificar('sin kilometraje inicial no deja salir', r.estado === 400, r.datos);

r = await api('POST', '/api/trayectos/salida',
  { municipio_id: 1, lugar: 'BASE', km_inicial: 1, tripulantes: 'A, B', foto: FOTO }, tCond);
verificar('sin número de tripulantes tampoco', r.estado === 400, r.datos);

r = await api('POST', '/api/trayectos/salida',
  { municipio_id: 1, lugar: 'BASE', km_inicial: 1, num_tripulantes: 4, foto: FOTO }, tCond);
verificar('sin los nombres de la tripulación tampoco', r.estado === 400, r.datos);

r = await api('POST', '/api/trayectos/salida',
  { municipio_id: 1, lugar: 'BASE', km_inicial: 1, num_tripulantes: 4, tripulantes: 'A, B' }, tCond);
verificar('sin fotografía tampoco', r.estado === 400, r.datos);

r = await api('POST', '/api/trayectos/salida', {
  municipio_id: 1, lugar: 'BASE ÁBREGO', lat: 8.0796, lon: -73.2216,
  precision: 12, km_inicial: 145200, num_tripulantes: 4,
  tripulantes: 'JEISON NAVARRO, ANA GÓMEZ, LUIS PÉREZ, SOFÍA RUIZ',
  foto: FOTO, ts_dispositivo: '2026-09-11T06:10:00Z',
}, tCond);
verificar('el conductor marca salida', r.estado === 200 && r.datos.consecutivo, r.datos);
const trayecto = r.datos.id;
verificar('el consecutivo tiene el formato esperado',
  /^TR-\d{4}-\d{6}$/.test(r.datos.consecutivo), r.datos.consecutivo);

const marcaServidor = r.datos.ts_salida;
verificar('la hora la pone el servidor, no el dispositivo',
  marcaServidor !== '2026-09-11T06:10:00Z', { servidor: marcaServidor });

r = await api('POST', '/api/trayectos/salida', { municipio_id: 1 }, tCond);
verificar('no permite dos trayectos abiertos a la vez', r.estado === 400, r.datos);

r = await api('POST', `/api/trayectos/${trayecto}/llegada`,
  { municipio_id: 1, lugar: 'HOYO PILÓN', foto: FOTO }, tCond);
verificar('sin kilometraje final no deja cerrar', r.estado === 400, r.datos);

r = await api('POST', `/api/trayectos/${trayecto}/llegada`,
  { municipio_id: 1, km_final: 100, foto: FOTO }, tCond);
verificar('rechaza un kilometraje final menor que el inicial', r.estado === 400, r.datos);
verificar('y lo explica con los dos números',
  /145200/.test(r.datos.error || ''), r.datos.error);

r = await api('POST', `/api/trayectos/${trayecto}/llegada`, {
  municipio_id: 1, lugar: 'HOYO PILÓN', lat: 8.1512, lon: -73.1904,
  precision: 25, km_final: 145247, foto: FOTO,
}, tCond);
verificar('el conductor marca llegada', r.estado === 200 && r.datos.ts_llegada, r.datos);

r = await api('PUT', `/api/trayectos/${trayecto}`, { km_final: 999999, motivo: 'me equivoqué' }, tCond);
verificar('el conductor NO corrige su propia marca', r.estado === 403, r.datos);

r = await api('PUT', `/api/trayectos/${trayecto}`, { km_final: 145250 }, tCoord);
verificar('toda corrección exige motivo', r.estado === 400, r.datos);

r = await api('PUT', `/api/trayectos/${trayecto}`, {
  km_final: 145250, motivo: 'El conductor reportó error de digitación',
}, tCoord);
verificar('coordinación sí corrige, con motivo', r.estado === 200, r.datos);

console.log('\n── Fotografías y tripulación ─────────────────────────────────');
r = await api('GET', `/api/trayectos/${trayecto}/fotos`, null, tCond);
verificar('guarda las dos fotografías', r.estado === 200 && r.datos.length === 2,
  r.datos.map ? r.datos.map(f => f.momento) : r.datos);
verificar('con su momento y sus coordenadas',
  r.datos.some(f => f.momento === 'salida' && f.lat === 8.0796), r.datos[0]);

r = await api('GET', '/api/trayectos?desde=2026-01-01&hasta=2027-12-31', null, tCoord);
const tr = r.datos.find(x => x.id === trayecto);
verificar('el listado guarda los nombres de la tripulación',
  (tr.tripulantes || '').includes('ANA GÓMEZ'), tr.tripulantes);
verificar('y dice qué fotografías tiene', (tr.fotos || '').includes('salida'), tr.fotos);
verificar('conserva las coordenadas de salida y llegada',
  tr.lat_salida === 8.0796 && tr.lat_llegada === 8.1512,
  { s: tr.lat_salida, l: tr.lat_llegada });

r = await api('POST', `/api/trayectos/${trayecto}/foto`,
  { momento: 'salida', foto: { mime: 'image/gif', datos: FOTO.datos } }, tCond);
verificar('rechaza un formato que no es foto', r.estado === 400, r.datos);

r = await api('POST', `/api/trayectos/${trayecto}/foto`,
  { momento: 'salida', foto: { mime: 'image/jpeg', datos: 'A'.repeat(900_000) } }, tCond);
verificar('rechaza una fotografía demasiado pesada', r.estado === 400, r.datos);

r = await api('GET', `/api/trayectos/${trayecto}/fotos`, null, tCond);
verificar('el propio conductor sí puede verlas', r.estado === 200, r.estado);

// Con la exigencia apagada, se puede marcar sin foto
await api('PUT', '/api/parametros/foto_obligatoria', { valor: '0' }, tokenPrincipal);
r = await api('POST', '/api/trayectos/salida',
  { municipio_id: 1, lugar: 'SIN FOTO', km_inicial: 200, num_tripulantes: 2,
    tripulantes: 'X, Y', fecha_operacion: '2026-10-20', vehiculo_id: vehiculo }, tCond);
verificar('si se apaga la exigencia, se puede marcar sin foto', r.estado === 200, r.datos);
await api('POST', `/api/trayectos/${r.datos.id}/llegada`, { km_final: 260 }, tCond);
await api('PUT', '/api/parametros/foto_obligatoria', { valor: '1' }, tokenPrincipal);

console.log('\n── Checklist de 5 distintivos + 4 elementos ──────────────────');
const items = [
  { item: 'lateral_izquierdo', estado: 'bueno' },
  { item: 'lateral_derecho', estado: 'bueno' },
  { item: 'frontal', estado: 'bueno' },
  { item: 'trasero', estado: 'obstruido', observacion: 'Tapado por el equipaje' },
  { item: 'techo', estado: 'bueno' },
  { item: 'bandera', estado: 'presente' },
  { item: 'chaleco', estado: 'presente', cantidad: 4 },
  { item: 'carnet', estado: 'presente' },
  { item: 'carta_presentacion', estado: 'ausente' },
];
r = await api('POST', '/api/checklists', {
  trayecto_id: trayecto, vehiculo_id: vehiculo, momento: 'presalida', items,
}, tCond);
verificar('registra el checklist de 9 ítems', r.estado === 200 && r.datos.completo, r.datos);
verificar('cuenta los faltantes (obstruido + ausente)', r.datos.faltantes === 2, r.datos);

r = await api('GET', '/api/eventos', null, tCond);
verificar('un faltante genera novedad automática',
  r.estado === 200 && r.datos.some(e => e.tipo === 'novedad_distintivo'), r.datos.length);

r = await api('GET', `/api/checklists?trayecto_id=${trayecto}`, null, tCoord);
verificar('el checklist se recupera con sus ítems',
  r.estado === 200 && r.datos[0] && r.datos[0].items.length === 9, r.datos[0] && r.datos[0].items.length);

console.log('\n── Protección de días ya ejecutados ──────────────────────────');
// Aquí el conductor ya marcó salida y llegada del día de hoy.
r = await api('DELETE', `/api/itinerario/${itinerario}?definitivo=1`, null, tokenPrincipal);
verificar('no deja borrar un día con viajes registrados', r.estado === 400, r.datos);
verificar('y lo explica nombrando los viajes', /viaje/i.test(r.datos.error || ''), r.datos.error);

r = await api('DELETE', `/api/itinerario/${itinerario}`, { motivo: 'x' }, tCoord);
verificar('tampoco deja cancelarlo', r.estado === 400, r.datos);

r = await api('POST', '/api/itinerario/mover', {
  id: itinerario, fecha: '2026-11-20', vehiculo_id: vehiculo,
}, tCoord);
verificar('tampoco deja moverlo', r.estado === 400, r.datos);

r = await api('POST', '/api/itinerario/lote', {
  operaciones: [{ accion: 'borrar', id: itinerario }],
}, tCoord);
verificar('ni borrarlo desde la plantilla de Excel',
  r.estado === 200 && r.datos.borradas === 0 && r.datos.errores.length === 1, r.datos);

console.log('\n── Bloqueo configurable de salida ────────────────────────────');
await api('PUT', '/api/parametros/checklist_bloquea_salida', { valor: 'bloquear' }, tokenPrincipal);
r = await api('POST', '/api/checklists', {
  vehiculo_id: vehiculo, momento: 'presalida', items,
}, tCond);
verificar('en modo bloquear, un faltante impide salir', r.estado === 400, r.datos);
r = await api('POST', '/api/checklists', {
  vehiculo_id: vehiculo, momento: 'presalida', items,
  excepcion_autorizada: true, justificacion: 'Se sale con carta en camino',
}, tokenPrincipal);
verificar('la excepción autorizada sí deja salir', r.estado === 200, r.datos);
await api('PUT', '/api/parametros/checklist_bloquea_salida', { valor: 'advertir' }, tokenPrincipal);

r = await api('PUT', '/api/parametros/gps_obligatorio', { valor: '0' }, tCoord);
verificar('coordinación NO cambia parámetros', r.estado === 403, r.datos);

console.log('\n── Días de operación y pago ──────────────────────────────────');
r = await api('GET', `/api/dias?desde=${hoy}&hasta=${hoy}`, null, tCoord);
const dia = r.datos[0];
verificar('el día quedó registrado', r.estado === 200 && !!dia, r.datos);
verificar('el día está programado y ejecutado',
  dia && dia.programado === 1 && dia.ejecutado === 1, dia);
verificar('el día ejecutado es pagable', dia && dia.dia_pagable === 1, dia);
verificar('calcula los kilómetros del día', dia && dia.km_dia === 50, dia && dia.km_dia);

// Día DISPONIBLE: se paga igual aunque no haya desplazamiento (D11)
await api('POST', '/api/itinerario', {
  fecha: '2026-10-05', vehiculo_id: vehiculo, conductor_id: personaConductor,
  municipio_id: 1, tipo_jornada: 'disponible',
}, tCoord);
r = await api('GET', '/api/dias?desde=2026-10-05&hasta=2026-10-05', null, tCoord);
const diaDisp = r.datos[0];
verificar('un día DISPONIBLE sin desplazamiento es pagable',
  diaDisp && diaDisp.dia_pagable === 1 && diaDisp.ejecutado === 0, diaDisp);
verificar('y queda marcado como disponible, no como operativo',
  diaDisp && diaDisp.estado_dia === 'disponible', diaDisp && diaDisp.estado_dia);

// Día programado con desplazamiento pero NO ejecutado: no se paga solo
await api('POST', '/api/itinerario', {
  fecha: '2026-10-06', vehiculo_id: vehiculo, municipio_id: 1,
  destino_nombre: 'LA LAGUNA', tipo_jornada: 'ebs',
}, tCoord);
r = await api('GET', '/api/dias?desde=2026-10-06&hasta=2026-10-06', null, tCoord);
verificar('un día programado y NO ejecutado no es pagable',
  r.datos[0] && r.datos[0].dia_pagable === 0, r.datos[0]);

r = await api('PUT', `/api/dias/${r.datos[0].id}`, { dia_pagable: 1 }, tokenPrincipal);
verificar('el ajuste manual exige motivo', r.estado === 400, r.datos);

r = await api('GET', '/api/dias?desde=2026-10-06&hasta=2026-10-06', null, tCoord);
const idAjuste = r.datos[0].id;
r = await api('PUT', `/api/dias/${idAjuste}`, {
  dia_pagable: 1, motivo_ajuste: 'El conductor operó sin señal, soporte en papel',
}, tokenPrincipal);
verificar('el principal ajusta el día con motivo', r.estado === 200, r.datos);

r = await api('GET', '/api/dias?desde=2026-10-06&hasta=2026-10-06', null, tCoord);
verificar('el ajuste queda marcado como manual',
  r.datos[0].ajuste_manual === 1 && r.datos[0].dia_pagable === 1, r.datos[0]);

r = await api('PUT', `/api/dias/${idAjuste}`, { dia_pagable: 0, motivo_ajuste: 'x' }, tCoord);
verificar('coordinación NO ajusta días pagables', r.estado === 403, r.datos);

console.log('\n── Sincronización sin señal ──────────────────────────────────');
r = await api('POST', '/api/sync', {
  marcas: [{
    local_id: 'abc', hito: 'salida', vehiculo_id: vehiculo,
    conductor_id: personaConductor, fecha_operacion: '2026-10-07',
    ts_dispositivo: '2026-10-07T05:45:00Z', lat: 8.07, lon: -73.22, precision: 40,
  }],
}, tCond);
verificar('sincroniza una marca capturada sin señal',
  r.estado === 200 && r.datos.resultados[0].ok, r.datos);

// Se busca la marca, no se da por hecho que sea la primera: el 2026-10-07 que
// esta sección usa puede coincidir con el día en que se corre la prueba, y
// entonces el viaje de hoy —que se registró más tarde— ordena antes.
r = await api('GET', '/api/trayectos?desde=2026-10-07&hasta=2026-10-07', null, tCoord);
const offline = r.datos.find(x => x.origen_salida === 'offline_sincronizado');
verificar('la marca offline queda etiquetada como tal', !!offline, r.datos.length);
verificar('y conserva la hora real del dispositivo',
  offline && offline.ts_salida === '2026-10-07T05:45:00Z', offline && offline.ts_salida);

// El período es libre, así que la consulta necesita tope: un año de flota son
// miles de filas y la pantalla las pide desde un celular.
r = await api('GET', '/api/trayectos?desde=2000-01-01&hasta=2100-01-01&limite=1', null, tCoord);
verificar('la consulta de viajes respeta el tope que se le pide',
  r.estado === 200 && r.datos.length === 1, r.datos.length);
r = await api('GET', '/api/trayectos?desde=2000-01-01&hasta=2100-01-01&limite=500', null, tCoord);
verificar('y con un tope alto trae todo el histórico', r.datos.length > 1, r.datos.length);
const masReciente = r.datos[0];
verificar('los más recientes van primero: es el recorte útil',
  r.datos.every(x => x.fecha_operacion <= masReciente.fecha_operacion), masReciente.fecha_operacion);

r = await api('GET', '/api/trayectos/rango', null, tCoord);
verificar('se puede preguntar desde cuándo hay viajes',
  r.estado === 200 && !!r.datos.primera && r.datos.total > 0, r.datos);

r = await api('GET', '/api/trayectos/rango', null, tCond);
verificar('al conductor el rango solo le cuenta los suyos',
  r.estado === 200 && r.datos.total < 10, r.datos);

console.log('\n── Dashboard ─────────────────────────────────────────────────');
r = await api('GET', '/api/dashboard?desde=2026-01-01&hasta=2026-12-31', null, tCoord);
verificar('el dashboard responde', r.estado === 200 && r.datos.por_vehiculo, r.datos);
const v = r.datos.por_vehiculo[0];
verificar('separa días pagables de días con desplazamiento',
  v && v.dias_pagables !== undefined && v.dias_con_desplazamiento !== undefined, v);
verificar('los días pagables superan los ejecutados (por el día disponible)',
  v && v.dias_pagables > v.dias_con_desplazamiento,
  { pagables: v && v.dias_pagables, ejecutados: v && v.dias_con_desplazamiento });
verificar('estima el valor con la tarifa por día',
  v && v.valor_estimado === v.dias_pagables * 180000,
  { valor: v && v.valor_estimado, dias: v && v.dias_pagables });
verificar('cuenta el origen de las marcas',
  r.datos.origen_marcas.some(o => o.origen === 'offline_sincronizado'), r.datos.origen_marcas);
// Se busca por contenido, no por posición: el orden cambia al agregar vehículos.
verificar('el checklist reporta faltantes por vehículo',
  r.datos.checklist.some(c => c.faltantes > 0),
  r.datos.checklist.map(c => `${c.placa}:${c.faltantes}`));

r = await api('GET', '/api/dashboard', null, tCond);
verificar('el conductor NO ve el dashboard', r.estado === 403, r.datos);

console.log('\n── Aislamiento del conductor ─────────────────────────────────');
r = await api('POST', '/api/personas', { nombres: 'OTRO', es_conductor: true }, tokenPrincipal);
const otraPersona = r.datos.id;
await api('POST', '/api/usuarios',
  { usuario: 'otro', clave: 'OtroCond2026', rol: 'conductor', persona_id: otraPersona },
  tokenPrincipal);
const tOtro = (await api('POST', '/api/auth/login',
  { usuario: 'otro', clave: 'OtroCond2026' })).datos.token;

r = await api('GET', '/api/trayectos?desde=2026-01-01&hasta=2026-12-31', null, tOtro);
verificar('un conductor no ve los trayectos de otro', r.estado === 200 && r.datos.length === 0,
          r.datos.length);

r = await api('POST', '/api/trayectos/salida',
  { conductor_id: personaConductor, vehiculo_id: vehiculo }, tOtro);
verificar('un conductor no marca a nombre de otro', r.estado === 403, r.datos);

console.log('\n── Cambio de clave y cierre de sesión ────────────────────────');
r = await api('POST', '/api/auth/cambiar-clave',
  { clave_actual: 'equivocada', clave_nueva: 'NuevaClave2026' }, tCond);
verificar('no cambia la clave sin la actual', r.estado === 401, r.datos);

r = await api('POST', '/api/auth/cambiar-clave',
  { clave_actual: 'Conductor2026', clave_nueva: 'corta' }, tCond);
verificar('exige longitud mínima', r.estado === 400, r.datos);

r = await api('POST', '/api/auth/cambiar-clave',
  { clave_actual: 'Conductor2026', clave_nueva: 'NuevaClave2026' }, tCond);
verificar('cambia la clave correctamente', r.estado === 200, r.datos);

r = await api('POST', '/api/auth/logout', null, tCond);
verificar('cierra sesión', r.estado === 200, r.datos);
r = await api('GET', '/api/mi-dia', null, tCond);
verificar('el token queda invalidado tras cerrar sesión', r.estado === 401, r.datos);

console.log('\n── Banner institucional ──────────────────────────────────────');
// PNG de 1x1 en base64, suficiente para ejercitar la ruta
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

r = await api('GET', '/api/banner');
verificar('sin banner responde vacío, y sin exigir sesión',
  r.estado === 200 && r.datos.vacio === true, r.datos);

r = await api('PUT', '/api/banner', { mime: 'image/png', datos: PNG, ancho: 2000, alto: 289 }, tCoord);
verificar('coordinación NO puede cambiar el banner', r.estado === 403, r.datos);

r = await api('PUT', '/api/banner', { mime: 'image/gif', datos: PNG }, tokenPrincipal);
verificar('rechaza un formato que no es imagen web', r.estado === 400, r.datos);

r = await api('PUT', '/api/banner',
  { mime: 'image/png', datos: 'A'.repeat(2_200_000) }, tokenPrincipal);
verificar('rechaza una imagen demasiado pesada', r.estado === 400, r.datos);

r = await api('PUT', '/api/banner',
  { mime: 'image/png', datos: PNG, ancho: 2000, alto: 289 }, tokenPrincipal);
verificar('el administrador sube el banner', r.estado === 200, r.datos);

r = await api('GET', '/api/banner');
verificar('se puede leer sin sesión, para la pantalla de ingreso',
  r.estado === 200 && r.datos.datos === PNG, { mime: r.datos.mime });
verificar('guarda las medidas', r.datos.ancho === 2000 && r.datos.alto === 289, r.datos);

r = await api('PUT', '/api/banner',
  { mime: 'image/webp', datos: PNG, ancho: 2000, alto: 289 }, tokenPrincipal);
verificar('reemplazarlo no crea un segundo registro', r.estado === 200, r.datos);
r = await api('GET', '/api/banner');
verificar('y queda el nuevo', r.datos.mime === 'image/webp', r.datos.mime);

r = await api('DELETE', '/api/banner', null, tCoord);
verificar('coordinación NO puede quitarlo', r.estado === 403, r.datos);
r = await api('DELETE', '/api/banner', null, tokenPrincipal);
verificar('el administrador sí lo quita', r.estado === 200, r.datos);
r = await api('GET', '/api/banner');
verificar('y vuelve a estar vacío', r.datos.vacio === true, r.datos);

console.log('\n── Documentos vencidos ───────────────────────────────────────');
db.prepare(`INSERT INTO documentos_vehiculo (vehiculo_id, tipo, vencimiento)
            VALUES (?, 'soat', date('now','-10 day'))`).bind(vehiculo).run();
db.prepare(`INSERT INTO documentos_persona (persona_id, tipo, vencimiento)
            VALUES (?, 'curso_mision_medica', date('now','-3 day'))`).bind(personaConductor).run();

r = await api('GET', '/api/vehiculos', null, tCoord);
const veh = r.datos.find(v => v.id === vehiculo);
verificar('el vehículo reporta el documento vencido', veh.docs_vencidos === 1, veh.docs_vencidos);
verificar('y dice cuál es', veh.docs_vencidos_tipos === 'soat', veh.docs_vencidos_tipos);

r = await api('GET', '/api/personas', null, tCoord);
const per = r.datos.find(p => p.id === personaConductor);
verificar('la persona reporta el curso vencido',
  per.docs_vencidos_tipos === 'curso_mision_medica', per.docs_vencidos_tipos);


console.log('\n── Días fuera de servicio ────────────────────────────────────');

// Un conductor propio para esta sección: `tCond` ya no sirve porque más arriba
// se le cambió la clave, y cambiar la clave cierra las sesiones abiertas.
await api('POST', '/api/usuarios', {
  usuario: 'condfs', clave: 'Conductor2026', rol: 'conductor',
  persona_id: personaConductor,
}, tokenPrincipal);
const tCondFS = (await api('POST', '/api/auth/login',
  { usuario: 'condfs', clave: 'Conductor2026' })).datos.token;
verificar('ingresa el conductor de esta sección', !!tCondFS);

// Un vehículo aparte, para no enredar los días que ya usaron las pruebas de arriba.
verificar('a estas alturas el Worker ya creó la tabla él solo',
  existeTabla('fuera_servicio'));

r = await api('POST', '/api/vehiculos', {
  placa: 'FSV-001', tipo: 'camioneta', propiedad: 'contratista',
  contratista: 'Transportes Prueba', valor_dia: 300000,
}, tokenPrincipal);
const vehFS = r.datos.id;

// Un día DISPONIBLE se paga sin que el conductor marque nada: es justo el que
// quedaría cobrando aunque el vehículo estuviera en el taller.
await api('POST', '/api/itinerario', {
  fecha: '2026-11-10', vehiculo_id: vehFS, tipo_jornada: 'disponible', municipio_id: 1,
}, tCoord);
r = await api('GET', '/api/dias?desde=2026-11-10&hasta=2026-11-10', null, tCoord);
verificar('antes de registrar la avería, el día DISPONIBLE se paga',
  r.datos[0] && r.datos[0].dia_pagable === 1, r.datos[0]);

r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'averia',
  fecha_inicio: '2026-11-08', fecha_fin: '2026-11-12',
  descripcion: 'Caja de velocidades', taller: 'Taller Ocaña',
}, tCoord);
verificar('coordinación registra el período fuera de servicio', r.estado === 200, r.datos);
const fsId = r.datos.id;
verificar('y avisa de los días que ya estaban programados',
  r.datos.programados.length === 1 && r.datos.programados[0].fecha === '2026-11-10',
  r.datos.programados);

r = await api('GET', '/api/dias?desde=2026-11-10&hasta=2026-11-10', null, tCoord);
verificar('el día deja de ser pagable', r.datos[0] && r.datos[0].dia_pagable === 0, r.datos[0]);
verificar('y queda marcado como fuera de servicio',
  r.datos[0] && r.datos[0].estado_dia === 'fuera_servicio', r.datos[0]);

r = await api('GET', '/api/dias?desde=2026-11-08&hasta=2026-11-12', null, tCoord);
verificar('los cinco días del rango quedan registrados', r.datos.length === 5, r.datos.length);
verificar('ninguno es pagable', r.datos.every(d => d.dia_pagable === 0), r.datos);

// El mantenimiento preventivo se distingue de la avería en el estado del día.
r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'mantenimiento',
  fecha_inicio: '2026-11-20', fecha_fin: '2026-11-21',
}, tCoord);
verificar('un mantenimiento preventivo también se registra', r.estado === 200, r.datos);
r = await api('GET', '/api/dias?desde=2026-11-20&hasta=2026-11-20', null, tCoord);
verificar('y el día se distingue como mantenimiento',
  r.datos[0] && r.datos[0].estado_dia === 'mantenimiento', r.datos[0]);

// Solapes: dos períodos del mismo vehículo contarían el día dos veces.
r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'accidente',
  fecha_inicio: '2026-11-11', fecha_fin: '2026-11-15',
}, tCoord);
verificar('rechaza un período que se solapa con otro', r.estado === 400, r.datos);
verificar('y dice con cuál choca',
  /2026-11-08/.test(r.datos.error || ''), r.datos);

r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'averia', fecha_inicio: '2026-12-05', fecha_fin: '2026-12-01',
}, tCoord);
verificar('rechaza un fin anterior al inicio', r.estado === 400, r.datos);

r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'inventada', fecha_inicio: '2026-12-05',
}, tCoord);
verificar('rechaza una causa que no existe', r.estado === 400, r.datos);

// Mover las fechas tiene que liberar los días que dejan de estar cubiertos.
r = await api('PUT', `/api/fuera-servicio/${fsId}`, {
  fecha_inicio: '2026-11-08', fecha_fin: '2026-11-09',
  motivo_cierre: 'Salió del taller antes de lo previsto',
}, tCoord);
verificar('se acorta el período', r.estado === 200 && r.datos.cerrado === true, r.datos);
r = await api('GET', '/api/dias?desde=2026-11-10&hasta=2026-11-10', null, tCoord);
verificar('el día que se libera vuelve a ser pagable',
  r.datos[0] && r.datos[0].dia_pagable === 1, r.datos[0]);
verificar('y vuelve a contar como disponible',
  r.datos[0] && r.datos[0].estado_dia === 'disponible', r.datos[0]);

// Un día con viajes CERRADOS manda sobre el registro: el vehículo operó.
r = await api('GET', `/api/dias?desde=${hoy}&hasta=${hoy}`, null, tCoord);
const diaTrabajado = r.datos.find(d => d.vehiculo_id === vehiculo && d.ejecutado === 1);
verificar('hay un día realmente ejecutado con el que contrastar', !!diaTrabajado, r.datos);
r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehiculo, causa: 'averia', fecha_inicio: hoy, fecha_fin: hoy,
}, tCoord);
verificar('deja registrar aunque ese día haya viajes', r.estado === 200, r.datos);
const fsChoque = r.datos.id;
r = await api('GET', `/api/dias?desde=${hoy}&hasta=${hoy}`, null, tCoord);
const tras = r.datos.find(d => d.vehiculo_id === vehiculo);
verificar('pero NO desconoce un día que el vehículo trabajó de verdad',
  tras && tras.dia_pagable === 1 && tras.estado_dia !== 'fuera_servicio', tras);
await api('DELETE', `/api/fuera-servicio/${fsChoque}`, null, tokenPrincipal);

// El conductor: solo su vehículo, solo desde hoy, sin fecha de fin.
r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'averia', descripcion: 'Se varó en la vía',
}, tCondFS);
verificar('el conductor NO puede reportar un vehículo que no es el suyo',
  r.estado === 403, r.datos);

r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehiculo, causa: 'averia', descripcion: 'Se varó subiendo',
  fecha_inicio: '2020-01-01', fecha_fin: '2030-01-01', taller: 'El que yo diga',
  foto: FOTO,
}, tCondFS);
verificar('el conductor sí reporta el suyo', r.estado === 200, r.datos);
const fsCond = r.datos.id;

r = await api('GET', `/api/fuera-servicio?vehiculo_id=${vehiculo}`, null, tCoord);
const suyo = r.datos.find(x => x.id === fsCond);
verificar('el reporte del conductor empieza HOY, no en la fecha que mandó',
  suyo && suyo.fecha_inicio === hoy, suyo);
verificar('y queda abierto: él no decide cuándo vuelve',
  suyo && suyo.fecha_fin === null, suyo);
verificar('queda registrado que lo reportó un conductor',
  suyo && suyo.rol_registro === 'conductor', suyo);
verificar('no se le acepta el taller: eso lo pone Coordinación',
  suyo && suyo.taller === null, suyo);
verificar('la lista dice que hay fotografía sin cargarla',
  suyo && suyo.tiene_foto === 1 && suyo.foto_datos === undefined, suyo);

r = await api('GET', `/api/fuera-servicio/${fsCond}/foto`, null, tCoord);
verificar('la fotografía se pide aparte', r.estado === 200 && !!r.datos.datos, r.estado);

r = await api('PUT', `/api/fuera-servicio/${fsCond}`, { fecha_fin: hoy }, tCondFS);
verificar('el conductor NO puede cerrar el período', r.estado === 403, r.datos);
r = await api('PUT', `/api/fuera-servicio/${fsCond}`, {
  fecha_fin: hoy, motivo_cierre: 'Arreglado en la vía',
}, tCoord);
verificar('coordinación sí lo cierra', r.estado === 200, r.datos);

r = await api('DELETE', `/api/fuera-servicio/${fsCond}`, null, tCoord);
verificar('coordinación NO borra un período', r.estado === 403, r.datos);
r = await api('DELETE', `/api/fuera-servicio/${fsCond}`, null, tokenPrincipal);
verificar('el administrador sí lo borra', r.estado === 200, r.datos);

// El resumen: lo que sostiene el descuento al contratista.
r = await api('GET', '/api/fuera-servicio/resumen', null, tCoord);
const resFS = r.datos.vehiculos.find(v => v.vehiculo_id === vehFS);
verificar('el resumen cuenta los días parados por vehículo',
  resFS && resFS.dias === 4, resFS);
verificar('y separa los de mantenimiento',
  resFS && resFS.dias_mantenimiento === 2, resFS);

r = await api('POST', '/api/fuera-servicio', {
  vehiculo_id: vehFS, causa: 'documentos', fecha_inicio: '2026-12-01',
}, tCoord);
verificar('un período sin fecha de fin se acepta', r.estado === 200, r.datos);
r = await api('GET', '/api/fuera-servicio', null, tCoord);
verificar('y sale en la lista de los que siguen parados',
  r.datos.some(x => x.vehiculo_id === vehFS && x.fecha_fin === null), r.datos.length);

r = await api('GET', '/api/fuera-servicio/resumen', null, tCondFS);
verificar('el conductor no ve el resumen de toda la flota', r.estado === 403, r.estado);

console.log('\n── Anular y borrar viajes (solo el administrador) ────────────');

// Un viaje propio para esta sección, con su día programado, para poder ver
// cómo se mueve el día pagable al quitarlo.
await api('POST', '/api/itinerario', {
  fecha: '2026-11-25', vehiculo_id: vehiculo, conductor_id: personaConductor,
  municipio_id: 1, destino_nombre: 'LA PLAYA', tipo_jornada: 'ebs',
}, tCoord);
r = await api('POST', '/api/sync', {
  marcas: [
    { local_id: 'b1', hito: 'salida', vehiculo_id: vehiculo, conductor_id: personaConductor,
      fecha_operacion: '2026-11-25', ts_dispositivo: '2026-11-25T06:00:00Z',
      municipio_id: 1, lugar: 'BASE', km: 200000, num_tripulantes: 2,
      tripulantes: 'UNO, DOS', lat: 8.07, lon: -73.22 },
  ],
}, tCondFS);
const idSalida = r.datos.resultados[0].id;
await api('POST', '/api/sync', {
  marcas: [
    { local_id: 'b2', hito: 'llegada', trayecto_id: idSalida, vehiculo_id: vehiculo,
      conductor_id: personaConductor, fecha_operacion: '2026-11-25',
      ts_dispositivo: '2026-11-25T14:00:00Z', municipio_id: 1, lugar: 'LA PLAYA',
      km: 200080, lat: 8.15, lon: -73.19 },
  ],
}, tCondFS);

r = await api('GET', '/api/dias?desde=2026-11-25&hasta=2026-11-25', null, tCoord);
verificar('el día del viaje queda pagable', r.datos[0] && r.datos[0].dia_pagable === 1, r.datos[0]);

r = await api('DELETE', `/api/trayectos/${idSalida}`, { motivo: 'Se registró mal' }, tCoord);
verificar('coordinación NO puede quitar un viaje', r.estado === 403, r.datos);
r = await api('DELETE', `/api/trayectos/${idSalida}`, { motivo: 'Se registró mal' }, tCondFS);
verificar('el conductor tampoco', r.estado === 403, r.datos);

r = await api('DELETE', `/api/trayectos/${idSalida}`, { motivo: 'ups' }, tokenPrincipal);
verificar('exige un motivo de verdad, no dos letras', r.estado === 400, r.datos);

r = await api('DELETE', `/api/trayectos/${idSalida}`,
  { motivo: 'Lo registró el conductor equivocado' }, tokenPrincipal);
verificar('el administrador lo anula', r.estado === 200 && r.datos.definitivo === false, r.datos);
verificar('y responde cómo quedó el día',
  r.datos.dia && r.datos.dia.dia_pagable === 0, r.datos.dia);

r = await api('GET', '/api/dias?desde=2026-11-25&hasta=2026-11-25', null, tCoord);
verificar('el día deja de ser pagable al anular el viaje',
  r.datos[0] && r.datos[0].dia_pagable === 0 && r.datos[0].ejecutado === 0, r.datos[0]);

r = await api('GET', '/api/trayectos?desde=2026-11-25&hasta=2026-11-25', null, tCoord);
verificar('el viaje anulado desaparece de la lista', r.datos.length === 0, r.datos.length);

r = await api('GET', '/api/trayectos?desde=2026-11-25&hasta=2026-11-25&anulados=1', null, tCoord);
verificar('y coordinación no puede destaparlo', r.datos.length === 0, r.datos.length);
r = await api('GET', '/api/trayectos?desde=2026-11-25&hasta=2026-11-25&anulados=1',
              null, tokenPrincipal);
const anulado = r.datos[0];
verificar('pero el administrador sí lo ve', !!anulado && anulado.estado === 'anulado', r.datos.length);
verificar('con el motivo en el propio registro, no solo en la auditoría',
  anulado && anulado.motivo_anulacion === 'Lo registró el conductor equivocado',
  anulado && anulado.motivo_anulacion);
verificar('y quién lo anuló',
  anulado && anulado.anulado_por_usuario === 'danilo', anulado && anulado.anulado_por_usuario);

// Deshacer
r = await api('POST', `/api/trayectos/${idSalida}/restaurar`, {}, tCoord);
verificar('coordinación NO puede deshacer la anulación', r.estado === 403, r.datos);
r = await api('POST', `/api/trayectos/${idSalida}/restaurar`, {}, tokenPrincipal);
verificar('el administrador deshace la anulación', r.estado === 200, r.datos);
r = await api('GET', '/api/dias?desde=2026-11-25&hasta=2026-11-25', null, tCoord);
verificar('y el día vuelve a ser pagable', r.datos[0] && r.datos[0].dia_pagable === 1, r.datos[0]);
r = await api('POST', `/api/trayectos/${idSalida}/restaurar`, {}, tokenPrincipal);
verificar('no se puede deshacer dos veces', r.estado === 400, r.datos);

// Una novedad colgada del viaje: tiene que sobrevivir al borrado.
r = await api('POST', '/api/eventos', {
  tipo: 'reten', descripcion: 'Retén en la vía', trayecto_id: idSalida,
  vehiculo_id: vehiculo, ts_evento: '2026-11-25T10:00:00Z',
}, tCondFS);
const idEvento = r.datos.id;

r = await api('DELETE', `/api/trayectos/${idSalida}?definitivo=1`,
  { motivo: 'Viaje de prueba que nunca existió' }, tokenPrincipal);
verificar('el administrador lo borra de verdad',
  r.estado === 200 && r.datos.definitivo === true, r.datos);

r = await api('GET', '/api/trayectos?desde=2026-11-25&hasta=2026-11-25&anulados=1',
              null, tokenPrincipal);
verificar('ya no está ni destapando los anulados', r.datos.length === 0, r.datos.length);
r = await api('GET', '/api/dias?desde=2026-11-25&hasta=2026-11-25', null, tCoord);
verificar('el día vuelve a quedar sin ejecutar',
  r.datos[0] && r.datos[0].ejecutado === 0 && r.datos[0].dia_pagable === 0, r.datos[0]);

r = await api('GET', '/api/eventos?desde=2026-11-25&hasta=2026-11-25', null, tCoord);
const ev = r.datos.find(x => x.id === idEvento);
verificar('la novedad sobrevive al viaje borrado: lo de la vía pasó', !!ev, r.datos.length);
verificar('y queda desenganchada, no apuntando a un viaje que no existe',
  ev && ev.trayecto_id === null, ev && ev.trayecto_id);

r = await api('DELETE', '/api/trayectos/999999', { motivo: 'no existe' }, tokenPrincipal);
verificar('un viaje que no existe responde 404', r.estado === 404, r.estado);

console.log('\n── Período libre en Novedades ────────────────────────────────');
r = await api('GET', '/api/eventos/rango', null, tCoord);
verificar('se puede preguntar desde cuándo hay novedades',
  r.estado === 200 && r.datos.total > 0 && !!r.datos.primera, r.datos);
r = await api('GET', '/api/eventos?desde=2000-01-01&hasta=2100-01-01&limite=1', null, tCoord);
verificar('la consulta de novedades respeta el tope', r.datos.length === 1, r.datos.length);

console.log('\n── Integridad de catálogos ───────────────────────────────────');
r = await api('DELETE', '/api/catalogos/destinos/8', null, tokenPrincipal);
verificar('borrar un destino solo lo desactiva', r.estado === 200 && r.datos.nota, r.datos);
r = await api('GET', `/api/itinerario?desde=${hoy}&hasta=${hoy}`, null, tCoord);
verificar('el itinerario histórico sobrevive al destino desactivado',
  r.estado === 200 && r.datos[0] && r.datos[0].destino === 'HOYO PILÓN', r.datos[0]);

r = await api('PUT', '/api/usuarios/1', { activo: 0 }, tokenPrincipal);
verificar('no deja al sistema sin usuario principal', r.estado === 400, r.datos);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${pruebas - fallos} de ${pruebas} verificaciones pasaron`);
if (fallos) { console.log(`  ${fallos} FALLARON`); process.exit(1); }
console.log('  Todo correcto.');
