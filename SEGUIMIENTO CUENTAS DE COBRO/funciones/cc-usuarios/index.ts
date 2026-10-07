// cc-usuarios — alta de usuarios del módulo Seguimiento de Cuentas de Cobro
//
// Crear una cuenta de acceso exige la llave de servicio de Supabase, que nunca
// puede ir en el navegador. Esta función la usa del lado del servidor y solo
// atiende a superadministradores del portal (portal_usuarios.rol_base).
//
// Acciones (POST JSON):
//   crear: { accion:'crear', correo, nombre_completo, cargo?, proceso, clave? }
//          Busca la cuenta por correo y la crea solo si no existe. Registra al
//          usuario en portal_usuarios (si es nuevo), cc_usuarios y el permiso
//          del módulo en portal_permisos. Si la cuenta ya existía y no se envía
//          clave, conserva la contraseña que tenga.
//   clave: { accion:'clave', usuario_id, clave? }
//          Asigna una contraseña provisional (o la enviada) a un usuario.
//
// verify_jwt va en false como las demás funciones del proyecto; la
// autorización se valida adentro con el token de sesión de quien llama.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PROCESOS = ['salud_publica', 'contratacion', 'subgerencia', 'tesoreria', 'lector'];
const MODULO = 'cuentas_cobro';

function json(datos: unknown, status = 200) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function svc(ruta: string, init: RequestInit = {}) {
  return fetch(`${SB_URL}${ruta}`, {
    ...init,
    headers: {
      apikey: SVC_KEY,
      Authorization: `Bearer ${SVC_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function leer(ruta: string) {
  const r = await svc(ruta);
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function escribir(ruta: string, metodo: string, cuerpo?: unknown, prefer = 'return=minimal') {
  const r = await svc(ruta, { method: metodo, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo), headers: { Prefer: prefer } });
  if (!r.ok) throw new Error(await r.text());
}

/** Id del usuario que llama, o null si no hay sesión válida. */
async function quienLlama(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token || token === Deno.env.get('SUPABASE_ANON_KEY')) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SVC_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ?? null;
}

async function esSuperadmin(id: string | null): Promise<boolean> {
  if (!id) return false;
  const filas = await leer(`/rest/v1/portal_usuarios?select=rol_base,activo&id=eq.${id}`);
  return filas?.[0]?.rol_base === 'superadmin' && filas[0].activo === true;
}

/** Clave provisional legible para dictar por teléfono, p. ej. KFTR-8294. */
function claveProvisional(): string {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const numeros = '23456789';
  const a = crypto.getRandomValues(new Uint32Array(4));
  const b = crypto.getRandomValues(new Uint32Array(4));
  let s = '';
  for (let i = 0; i < 4; i++) s += letras[a[i] % letras.length];
  s += '-';
  for (let i = 0; i < 4; i++) s += numeros[b[i] % numeros.length];
  return s;
}

const correoValido = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;

async function idPorCorreo(correo: string): Promise<string | null> {
  const r = await svc('/rest/v1/rpc/dnt_auth_id_por_correo', { method: 'POST', body: JSON.stringify({ p_email: correo }) });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function crear(body: Record<string, unknown>) {
  const correo = String(body.correo ?? '').trim().toLowerCase();
  const nombre = String(body.nombre_completo ?? '').trim().toUpperCase();
  const cargo = String(body.cargo ?? '').trim() || null;
  const proceso = String(body.proceso ?? '');
  let clave = String(body.clave ?? '').trim() || null;

  if (!correoValido(correo)) return json({ error: 'Correo no válido' }, 400);
  if (!nombre) return json({ error: 'El nombre completo es obligatorio' }, 400);
  if (!PROCESOS.includes(proceso)) return json({ error: 'Rol del módulo no válido' }, 400);
  if (clave && clave.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);

  let id = await idPorCorreo(correo);
  let creada = false;
  if (id) {
    // Cuenta existente (p. ej. ya usa otro módulo): se confirma y solo se cambia la clave si se pidió
    const cuerpo: Record<string, unknown> = { email_confirm: true };
    if (clave) cuerpo.password = clave;
    const r = await svc(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
    if (!r.ok) throw new Error('No se pudo actualizar la cuenta: ' + (await r.text()));
  } else {
    clave = clave || claveProvisional();
    const r = await svc('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: correo, password: clave, email_confirm: true, user_metadata: { nombre } }),
    });
    const u = await r.json();
    if (!r.ok) throw new Error(u?.msg || u?.message || 'No se pudo crear la cuenta');
    id = u.id;
    creada = true;
  }

  // Perfil del portal: se crea si no existe; si existe no se toca su rol base
  const perfil = await leer(`/rest/v1/portal_usuarios?select=id&id=eq.${id}`);
  if (!perfil.length) {
    await escribir('/rest/v1/portal_usuarios', 'POST', { id, nombre, email: correo, rol_base: 'administrativo', activo: true });
  }

  await escribir('/rest/v1/cc_usuarios?on_conflict=usuario_id', 'POST',
    { usuario_id: id, nombre_completo: nombre, cargo, proceso, activo: true },
    'resolution=merge-duplicates,return=minimal');

  // Permiso del módulo en el portal (lectura para lectores, registro para editores)
  await escribir(`/rest/v1/portal_permisos?usuario_id=eq.${id}&modulo_id=eq.${MODULO}`, 'DELETE');
  await escribir('/rest/v1/portal_permisos', 'POST',
    { usuario_id: id, modulo_id: MODULO, nivel: proceso === 'lector' ? 'lectura' : 'registro', activo: true });

  return json({ id, correo, creada, clave: creada || body.clave ? clave : null });
}

async function cambiarClave(body: Record<string, unknown>) {
  const id = String(body.usuario_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Usuario no válido' }, 400);
  const clave = String(body.clave ?? '').trim() || claveProvisional();
  if (clave.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  const r = await svc(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: clave, email_confirm: true }) });
  if (!r.ok) throw new Error('No se pudo cambiar la contraseña: ' + (await r.text()));
  return json({ id, clave });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  try {
    const quien = await quienLlama(req);
    if (!(await esSuperadmin(quien))) return json({ error: 'Solo el superadministrador del portal puede gestionar usuarios' }, 403);
    const body = await req.json();
    if (body.accion === 'crear') return await crear(body);
    if (body.accion === 'clave') return await cambiarClave(body);
    return json({ error: 'Acción desconocida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
