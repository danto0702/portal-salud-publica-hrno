// portal-usuarios — alta de usuarios del Portal de Salud Pública (superadmin.html)
//
// superadmin.html llamaba a auth.admin.createUser desde el navegador, lo que
// exige la llave de servicio y por eso fallaba con la llave pública del portal.
// Esta función hace el alta del lado del servidor y solo atiende a
// superadministradores activos del portal (portal_usuarios.rol_base).
//
// POST { accion:'crear', nombre, correo, clave, rol_base, permisos:[{modulo_id, nivel}] }
//   - Si el correo ya está en portal_usuarios, responde 409.
//   - Si la cuenta de acceso ya existe (p. ej. de otro módulo), la reutiliza,
//     la confirma y le asigna la clave enviada.
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

const ROLES = ['superadmin', 'admin', 'coordinador', 'auxiliar', 'administrativo'];
const NIVELES = ['lectura', 'registro', 'reportes', 'admin'];

function json(datos: unknown, status = 200) {
  return new Response(JSON.stringify(datos), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function svc(ruta: string, init: RequestInit = {}) {
  return fetch(`${SB_URL}${ruta}`, {
    ...init,
    headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function leer(ruta: string) {
  const r = await svc(ruta);
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

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

const correoValido = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;

async function crear(body: Record<string, unknown>, quien: string) {
  const nombre = String(body.nombre ?? '').trim();
  const correo = String(body.correo ?? '').trim().toLowerCase();
  const clave = String(body.clave ?? '');
  let rol = String(body.rol_base ?? '');
  if (rol === 'auxiliar_campo') rol = 'auxiliar';
  const permisos = Array.isArray(body.permisos) ? body.permisos as { modulo_id: string; nivel: string }[] : [];

  if (!nombre) return json({ error: 'El nombre es obligatorio' }, 400);
  if (!correoValido(correo)) return json({ error: 'Correo no válido' }, 400);
  if (clave.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  if (!ROLES.includes(rol)) return json({ error: 'Rol base no válido' }, 400);
  for (const p of permisos) {
    if (!p || typeof p.modulo_id !== 'string' || !NIVELES.includes(p.nivel)) return json({ error: 'Permiso no válido' }, 400);
  }

  // ilike sin comodines: se escapan % y _ (el _ es común en correos)
  const patron = correo.replace(/[\\%_]/g, (c) => '\\' + c);
  const yaPortal = await leer(`/rest/v1/portal_usuarios?select=id&email=ilike.${encodeURIComponent(patron)}`);
  if (yaPortal.length) return json({ error: 'Ya existe un usuario del portal con ese correo' }, 409);

  const r0 = await svc('/rest/v1/rpc/dnt_auth_id_por_correo', { method: 'POST', body: JSON.stringify({ p_email: correo }) });
  if (!r0.ok) throw new Error(await r0.text());
  let id: string | null = await r0.json();

  if (id) {
    const r = await svc(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: clave, email_confirm: true }) });
    if (!r.ok) throw new Error('No se pudo actualizar la cuenta: ' + (await r.text()));
  } else {
    const r = await svc('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: correo, password: clave, email_confirm: true, user_metadata: { nombre } }),
    });
    const u = await r.json();
    if (!r.ok) throw new Error(u?.msg || u?.message || 'No se pudo crear la cuenta');
    id = u.id;
  }

  const rp = await svc('/rest/v1/portal_usuarios', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ id, nombre, email: correo, rol_base: rol, activo: true, creado_por: quien }),
  });
  if (!rp.ok) throw new Error('Perfil: ' + (await rp.text()));

  if (permisos.length) {
    const filas = permisos.map(p => ({ usuario_id: id, modulo_id: p.modulo_id, nivel: p.nivel, activo: true, otorgado_por: quien }));
    const rr = await svc('/rest/v1/portal_permisos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(filas) });
    if (!rr.ok) throw new Error('Permisos: ' + (await rr.text()));
  }

  return json({ id, correo });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  try {
    const quien = await quienLlama(req);
    if (!(await esSuperadmin(quien))) return json({ error: 'Solo el superadministrador del portal puede crear usuarios' }, 403);
    const body = await req.json();
    if (body.accion === 'crear') return await crear(body, quien!);
    return json({ error: 'Acción desconocida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
