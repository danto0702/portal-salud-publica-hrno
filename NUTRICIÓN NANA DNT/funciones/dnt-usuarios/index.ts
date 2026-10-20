// dnt-usuarios — alta y mantenimiento de cuentas del módulo NANA DNT
//
// Por qué existe
// --------------
// El registro vivía en el navegador: signUp y, acto seguido, un insert en
// dnt_perfiles. Eso se rompe de dos maneras, y las dos se vieron en producción:
//
//   1. El proyecto tiene activada la confirmación de correo, así que signUp no
//      devuelve sesión. El insert salía como «anon», sin política que lo
//      amparara, y el perfil nunca se creaba: la solicitud no llegaba al panel
//      del administrador aunque la cuenta sí quedara en auth.users.
//   2. Si el correo ya tenía cuenta, GoTrue devuelve un usuario ofuscado con un
//      uuid inventado —así no se puede averiguar quién está registrado—, y el
//      insert reventaba contra dnt_perfiles_id_fkey.
//
// Aquí la llave de servicio resuelve primero la cuenta (la busca por correo y
// la crea sólo si no existe) y después toca el perfil. El cliente ya no tiene
// que adivinar si hubo sesión.
//
// verify_jwt va en false porque «solicitar» y «olvide» deben funcionar sin
// sesión. La autorización se hace adentro: «crear», «clave» y «estado» exigen
// que quien llame sea administrador del módulo según dnt_rol_de().

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ROLES = ['admin', 'coordinador', 'responsable'];
const ESTADOS = ['activo', 'pendiente', 'inactivo', 'rechazado'];

// Freno contra el registro masivo: «solicitar» es público. No pretende ser una
// defensa fina, sólo evitar que una madrugada aparezcan mil cuentas.
const TOPE_PENDIENTES = 60;

// Lo mismo para las solicitudes de contraseña, que tambien son publicas.
const TOPE_SOLICITUDES_CLAVE = 40;

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

async function rpc(nombre: string, args: Record<string, unknown>) {
  const r = await svc(`/rest/v1/rpc/${nombre}`, { method: 'POST', body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${nombre}: ${await r.text()}`);
  return await r.json();
}

/** Quién llama, según el token de sesión. null si no hay o no sirve. */
async function quienLlama(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token || token === Deno.env.get('SUPABASE_ANON_KEY')) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SVC_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ?? null;
}

async function esAdmin(usuario: string | null): Promise<boolean> {
  if (!usuario) return false;
  return (await rpc('dnt_rol_de', { p_usuario: usuario })) === 'admin';
}

function limpiarCorreo(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function correoValido(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
}

/** Clave provisional legible: el administrador la dicta por teléfono. */
function claveProvisional(): string {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';      // sin I ni O, que se confunden
  const numeros = '23456789';                      // sin 0 ni 1, por lo mismo
  const azar = (n: number) => crypto.getRandomValues(new Uint32Array(n));
  const a = azar(4), b = azar(4);
  let s = '';
  for (let i = 0; i < 4; i++) s += letras[a[i] % letras.length];
  s += '-';
  for (let i = 0; i < 4; i++) s += numeros[b[i] % numeros.length];
  return s;   // p. ej. KFTR-8294
}

/** Busca la cuenta por correo; la crea sólo si no existe. */
async function cuentaDe(correo: string, nombre: string, clave: string | null) {
  const id: string | null = await rpc('dnt_auth_id_por_correo', { p_email: correo });
  if (id) {
    // Cuenta previa del portal, o registro que quedó a medias sin confirmar.
    // Se confirma para que pueda entrar; la contraseña sólo se toca si se pidió.
    const cuerpo: Record<string, unknown> = { email_confirm: true };
    if (clave) cuerpo.password = clave;
    const r = await svc(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
    if (!r.ok) throw new Error(`No se pudo actualizar la cuenta: ${await r.text()}`);
    return { id, creada: false };
  }

  const r = await svc('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: correo,
      password: clave,
      email_confirm: true,
      user_metadata: { nombre },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.msg || d.message || d.error_description || 'No se pudo crear la cuenta');
  return { id: d.id as string, creada: true };
}

async function perfilDe(id: string) {
  const r = await svc(`/rest/v1/dnt_perfiles?select=id,nombre,email,rol,estado&id=eq.${id}`);
  const filas = await r.json();
  return Array.isArray(filas) && filas.length ? filas[0] : null;
}

async function municipiosValidos(pedidos: unknown): Promise<string[]> {
  if (!Array.isArray(pedidos) || !pedidos.length) return [];
  const r = await svc('/rest/v1/dnt_municipios?select=codigo&activo=is.true');
  const validos = new Set((await r.json()).map((m: { codigo: string }) => m.codigo));
  return [...new Set(pedidos.map((m) => String(m)))].filter((m) => validos.has(m));
}

async function fijarMunicipios(usuario: string, municipios: string[], porQuien: string | null) {
  await svc(`/rest/v1/dnt_usuarios_municipio?usuario_id=eq.${usuario}`, { method: 'DELETE' });
  if (!municipios.length) return;
  await svc('/rest/v1/dnt_usuarios_municipio', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(municipios.map((m) => ({
      usuario_id: usuario, municipio: m, asignado_por: porQuien,
    }))),
  });
}

/** Cuántas filas cumplen un filtro, sin traerlas. */
async function cuantas(ruta: string): Promise<number> {
  const r = await svc(ruta, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10);
}

/**
 * Marca que la contraseña vigente la puso el administrador. El modulo obliga a
 * cambiarla al entrar, asi que una provisional no se queda de definitiva.
 */
async function marcarProvisional(usuario: string, provisional: boolean) {
  await svc(`/rest/v1/dnt_perfiles?id=eq.${usuario}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      clave_provisional: provisional,
      actualizado_en: new Date().toISOString(),
    }),
  });
}

/** Cierra la solicitud de contraseña que estuviera pendiente. */
async function cerrarSolicitudClave(usuario: string, porQuien: string | null) {
  await svc(`/rest/v1/dnt_solicitudes_clave?perfil_id=eq.${usuario}&estado=eq.pendiente`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      estado: 'atendida', atendida_por: porQuien, atendida_en: new Date().toISOString(),
    }),
  });
}

/** Auditoría. Nunca hace fallar la operación que la originó. */
async function anotar(usuario: string | null, evento: string, detalle: Record<string, unknown>) {
  try {
    await svc('/rest/v1/dnt_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ usuario_id: usuario, evento, entidad: 'dnt_perfiles', detalle }),
    });
  } catch { /* la auditoría no manda sobre el flujo */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const accion = String(cuerpo.accion || '');
    const quien = await quienLlama(req);

    // ── Solicitud de acceso (pública, sin sesión) ────────────────────────
    if (accion === 'solicitar') {
      const correo = limpiarCorreo(cuerpo.email);
      const nombre = String(cuerpo.nombre || '').trim();
      const clave = String(cuerpo.clave || '');
      const municipio = String(cuerpo.municipio || '').trim();

      if (!correoValido(correo)) return json({ error: 'El correo no tiene un formato válido.' }, 400);
      if (nombre.length < 5) return json({ error: 'Escriba el nombre completo.' }, 400);
      if (clave.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);

      const muni = await municipiosValidos([municipio]);
      if (!muni.length) return json({ error: 'Seleccione un municipio válido.' }, 400);

      if (await cuantas('/rest/v1/dnt_perfiles?select=id&estado=eq.pendiente') >= TOPE_PENDIENTES) {
        return json({ error: 'Hay demasiadas solicitudes sin revisar. Comuníquese con la Coordinación de Salud Pública.' }, 429);
      }

      const existente: string | null = await rpc('dnt_auth_id_por_correo', { p_email: correo });
      if (existente) {
        const perfil = await perfilDe(existente);
        if (perfil) {
          // Ya pidió acceso antes, o ya lo tiene. No se pisa nada.
          return json({ ya_existe: true, estado: perfil.estado, cuenta_nueva: false });
        }
      }

      // Si la cuenta ya existía (la del portal), no se le cambia la contraseña:
      // entra con la que ya usa. Sólo las cuentas nuevas estrenan la que eligió.
      const { id, creada } = await cuentaDe(correo, nombre, existente ? null : clave);

      const r = await svc('/rest/v1/dnt_perfiles', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          id,
          nombre,
          email: correo,
          telefono: String(cuerpo.telefono || '').trim() || null,
          cargo: String(cuerpo.cargo || '').trim() || null,
          rol: 'responsable',
          estado: 'pendiente',
          municipio_solicitado: muni[0],
        }),
      });
      if (!r.ok) return json({ error: `No se pudo registrar la solicitud: ${await r.text()}` }, 500);

      await anotar(id, 'solicitud_acceso', { email: correo, municipio: muni[0], cuenta_nueva: creada });
      return json({ ok: true, estado: 'pendiente', cuenta_nueva: creada });
    }

    // ── Olvidé mi contraseña (pública, sin sesión) ───────────────────────
    // No manda correo: deja la solicitud en la bandeja del administrador, que
    // genera la provisional y se la entrega a la persona. El correo de Supabase
    // llegaba a buzones institucionales que nadie revisa, y el enlace caducaba
    // antes de que lo abrieran.
    if (accion === 'olvide') {
      const correo = limpiarCorreo(cuerpo.email);

      // La respuesta es siempre la misma, exista o no la cuenta: si cambiara,
      // este endpoint diria quien esta registrado a cualquiera que pregunte.
      const generica = { ok: true };
      if (!correoValido(correo)) return json(generica);

      const id: string | null = await rpc('dnt_auth_id_por_correo', { p_email: correo });
      if (!id) return json(generica);
      const perfil = await perfilDe(id);
      if (!perfil) return json(generica);

      if (await cuantas('/rest/v1/dnt_solicitudes_clave?select=id&estado=eq.pendiente')
            >= TOPE_SOLICITUDES_CLAVE) {
        return json({ error: 'Hay demasiadas solicitudes sin atender. Comuníquese con la Coordinación de Salud Pública.' }, 429);
      }

      const r = await svc('/rest/v1/dnt_solicitudes_clave', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ perfil_id: id, email: correo }),
      });
      // 409 es el indice unico parcial: ya tenia una pendiente. No es un error,
      // es exactamente lo que se queria evitar.
      if (!r.ok && r.status !== 409) {
        return json({ error: `No se pudo registrar la solicitud: ${await r.text()}` }, 500);
      }
      if (r.ok) await anotar(id, 'solicitud_clave', { email: correo });
      return json(generica);
    }

    // ── De aquí en adelante, sólo el administrador ───────────────────────
    if (!(await esAdmin(quien))) return json({ error: 'Acción restringida al administrador del módulo.' }, 403);

    // Alta o reemplazo completo de un usuario.
    if (accion === 'crear') {
      const correo = limpiarCorreo(cuerpo.email);
      const nombre = String(cuerpo.nombre || '').trim();
      if (!correoValido(correo)) return json({ error: 'El correo no tiene un formato válido.' }, 400);
      if (nombre.length < 5) return json({ error: 'Escriba el nombre completo.' }, 400);

      const rol = ROLES.includes(cuerpo.rol) ? cuerpo.rol : 'responsable';
      const municipios = rol === 'responsable' ? await municipiosValidos(cuerpo.municipios) : [];
      if (rol === 'responsable' && !municipios.length) {
        return json({ error: 'Un responsable sin municipio no vería ningún caso. Marque al menos uno.' }, 400);
      }

      const previo: string | null = await rpc('dnt_auth_id_por_correo', { p_email: correo });
      // A una cuenta que ya existe no se le cambia la contraseña sin pedirlo:
      // es la misma del Portal de Salud Pública.
      const clave = previo
        ? (cuerpo.reiniciar_clave ? claveProvisional() : null)
        : (String(cuerpo.clave || '') || claveProvisional());

      const { id, creada } = await cuentaDe(correo, nombre, clave);

      const r = await svc('/rest/v1/dnt_perfiles', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          id,
          nombre,
          email: correo,
          telefono: String(cuerpo.telefono || '').trim() || null,
          cargo: String(cuerpo.cargo || '').trim() || null,
          rol,
          estado: 'activo',
          aprobado_por: quien,
          aprobado_en: new Date().toISOString(),
          actualizado_en: new Date().toISOString(),
        }),
      });
      if (!r.ok) return json({ error: `No se pudo guardar el perfil: ${await r.text()}` }, 500);

      // Si se le genero contrasena, es provisional: la cambia al entrar.
      // Si reutiliza la cuenta del portal, no se le toco nada.
      await marcarProvisional(id, !!clave);
      if (clave) await cerrarSolicitudClave(id, quien);

      await fijarMunicipios(id, municipios, quien);
      await anotar(quien, 'usuario_creado', { objetivo: id, email: correo, rol, municipios, cuenta_nueva: creada });

      return json({ ok: true, id, cuenta_nueva: creada, clave: clave, rol, municipios });
    }

    // Contraseña nueva para alguien que la perdió.
    if (accion === 'clave') {
      const objetivo = String(cuerpo.id || '');
      if (!objetivo) return json({ error: 'Falta el usuario.' }, 400);
      const perfil = await perfilDe(objetivo);
      if (!perfil) return json({ error: 'Ese usuario no pertenece al módulo.' }, 404);

      const clave = claveProvisional();
      const r = await svc(`/auth/v1/admin/users/${objetivo}`, {
        method: 'PUT',
        body: JSON.stringify({ password: clave, email_confirm: true }),
      });
      if (!r.ok) return json({ error: `No se pudo cambiar la contraseña: ${await r.text()}` }, 500);

      await marcarProvisional(objetivo, true);
      await cerrarSolicitudClave(objetivo, quien);
      await anotar(quien, 'clave_reiniciada', { objetivo, email: perfil.email });
      return json({ ok: true, clave });
    }

    // Aprobar, rechazar o desactivar, incluida la asignación de municipios.
    if (accion === 'estado') {
      const objetivo = String(cuerpo.id || '');
      const perfil = objetivo ? await perfilDe(objetivo) : null;
      if (!perfil) return json({ error: 'Ese usuario no pertenece al módulo.' }, 404);
      if (objetivo === quien) return json({ error: 'No puede cambiarse a sí mismo desde aquí.' }, 400);

      const rol = ROLES.includes(cuerpo.rol) ? cuerpo.rol : perfil.rol;
      const estado = ESTADOS.includes(cuerpo.estado) ? cuerpo.estado : perfil.estado;
      const municipios = rol === 'responsable' ? await municipiosValidos(cuerpo.municipios) : [];
      if (rol === 'responsable' && estado === 'activo' && !municipios.length) {
        return json({ error: 'Un responsable sin municipio no vería ningún caso. Marque al menos uno.' }, 400);
      }

      const r = await svc(`/rest/v1/dnt_perfiles?id=eq.${objetivo}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          rol, estado,
          aprobado_por: quien,
          aprobado_en: new Date().toISOString(),
          actualizado_en: new Date().toISOString(),
        }),
      });
      if (!r.ok) return json({ error: `No se pudo guardar: ${await r.text()}` }, 500);

      // Aprobar a alguien cuya cuenta nunca se confirmo no servia de nada: al
      // entrar chocaba con «Email not confirmed». Pasa con las cuentas que
      // quedaron a medias antes de que el registro viniera por aqui.
      if (estado === 'activo') {
        await svc(`/auth/v1/admin/users/${objetivo}`, {
          method: 'PUT', body: JSON.stringify({ email_confirm: true }),
        });
      }

      await fijarMunicipios(objetivo, municipios, quien);
      await anotar(quien, 'usuario_actualizado', { objetivo, email: perfil.email, rol, estado, municipios });
      return json({ ok: true, rol, estado, municipios });
    }

    return json({ error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
