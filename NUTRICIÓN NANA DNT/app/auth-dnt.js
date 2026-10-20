// auth-dnt.js — Sesión, roles y alcance territorial
// Usa el mismo proyecto Supabase del portal (SI-APS HRNO) y la misma cuenta de
// usuario, pero el rol dentro de este módulo vive en la tabla dnt_perfiles.
//
// Roles:
//   admin        — ve y edita todo, gestiona usuarios y elimina documentos
//   coordinador  — ve todos los municipios, descarga y cierra casos; no edita datos
//   responsable  — ve y edita únicamente los municipios que tiene asignados

(function (global) {
  'use strict';

  var SUPA_URL = 'https://wttljozqyaxlzilomnef.supabase.co';
  var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0dGxqb3pxeWF4bHppbG9tbmVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDg5NTEsImV4cCI6MjA5NDg4NDk1MX0.kAQkgGq7RmZxTM9KlwI6KI7BjhEBy-8w6OdHVkOPBDM';

  var sb = global.supabase.createClient(SUPA_URL, SUPA_KEY);
  var _sesion = null;

  function urlLogin(motivo) {
    return 'login.html' + (motivo ? '?motivo=' + encodeURIComponent(motivo) : '');
  }

  /** Carga el perfil del módulo y los municipios del usuario autenticado. */
  async function cargarPerfil(userId) {
    var perfil = await sb.from('dnt_perfiles')
      .select('id,nombre,email,rol,estado,cargo,telefono,clave_provisional')
      .eq('id', userId).maybeSingle();
    if (perfil.error) throw new Error(perfil.error.message);

    // El superadministrador del portal entra como admin aunque no tenga perfil propio.
    if (!perfil.data) {
      var portal = await sb.from('portal_usuarios')
        .select('id,nombre,email,rol_base,activo').eq('id', userId).maybeSingle();
      if (portal.data && portal.data.rol_base === 'superadmin' && portal.data.activo) {
        perfil = { data: { id: userId, nombre: portal.data.nombre, email: portal.data.email,
                           rol: 'admin', estado: 'activo', cargo: 'Portal Salud Pública' } };
      } else {
        throw new Error('sin_perfil');
      }
    }
    if (perfil.data.estado === 'pendiente')  throw new Error('pendiente');
    if (perfil.data.estado === 'rechazado')  throw new Error('rechazado');
    if (perfil.data.estado !== 'activo')     throw new Error('inactivo');

    var muni = await sb.from('dnt_municipios').select('codigo,nombre,lat,lng').eq('activo', true).order('orden');
    var mios = await sb.from('dnt_usuarios_municipio').select('municipio').eq('usuario_id', userId);

    var todos = (muni.data || []).map(function (m) { return m.codigo; });
    var alcance = perfil.data.rol === 'responsable'
      ? (mios.data || []).map(function (r) { return r.municipio; })
      : todos;

    return {
      usuario: perfil.data,
      rol: perfil.data.rol,
      municipios: muni.data || [],
      alcance: alcance,
      // La contraseña la puso el administrador: hay que cambiarla antes de
      // entrar. No se expulsa la sesión, porque para cambiarla hace falta.
      debeCambiarClave: perfil.data.clave_provisional === true,
      cargado_en: Date.now()
    };
  }

  /** Llamar al inicio de cada página protegida. Redirige si no hay sesión válida. */
  async function verificar() {
    var s = await sb.auth.getSession();
    var session = s.data && s.data.session;
    if (!session) { location.href = urlLogin(); return null; }
    try {
      _sesion = await cargarPerfil(session.user.id);
      if (_sesion.debeCambiarClave) { location.href = urlLogin('cambie_clave'); return null; }
      return _sesion;
    } catch (e) {
      await sb.auth.signOut();
      location.href = urlLogin(e.message);
      return null;
    }
  }

  function sesion()      { return _sesion; }
  function usuario()     { return _sesion && _sesion.usuario; }
  function rol()         { return _sesion ? _sesion.rol : null; }
  function esAdmin()     { return rol() === 'admin'; }
  function esCoord()     { return rol() === 'coordinador'; }
  function esResp()      { return rol() === 'responsable'; }
  function veTodo()      { return esAdmin() || esCoord(); }
  function alcance()     { return _sesion ? _sesion.alcance : []; }
  function municipios()  { return _sesion ? _sesion.municipios : []; }

  function nombreMunicipio(codigo) {
    var m = municipios().filter(function (x) { return x.codigo === codigo; })[0];
    return m ? m.nombre : codigo;
  }

  /** ¿Puede ver este municipio? */
  function puedeVer(mun) { return alcance().indexOf(mun) >= 0; }

  /** ¿Puede escribir en este municipio? El coordinador es de sólo lectura. */
  function puedeEditar(mun) {
    if (esAdmin()) return true;
    if (esResp())  return puedeVer(mun);
    return false;
  }

  /** ¿Puede cerrar o reabrir casos? Sólo coordinador y admin. */
  function puedeCerrarCasos() { return esAdmin() || esCoord(); }

  /** ¿Puede eliminar documentos? Sólo admin. */
  function puedeEliminar() { return esAdmin(); }

  // ── Autenticación ────────────────────────────────────────────────
  async function ingresar(email, clave) {
    var r = await sb.auth.signInWithPassword({ email: email.trim(), password: clave });
    if (r.error) throw r.error;
    return cargarPerfil(r.data.user.id);   // lanza si el perfil no está activo
  }

  // ── Alta de cuentas ──────────────────────────────────────────────
  // Todo pasa por la función de borde dnt-usuarios, que usa la llave de
  // servicio. El navegador no puede hacerlo solo: signUp no devuelve sesión
  // cuando el proyecto pide confirmar el correo —así que el insert en
  // dnt_perfiles salía como «anon» y lo frenaba RLS— y, si el correo ya tenía
  // cuenta, devuelve un usuario ofuscado con un uuid inventado que reventaba
  // contra dnt_perfiles_id_fkey. La función busca la cuenta por correo, la crea
  // sólo si hace falta, y recién entonces toca el perfil.

  async function llamar(accion, datos) {
    var r = await sb.functions.invoke('dnt-usuarios', {
      body: Object.assign({ accion: accion }, datos || {})
    });
    if (r.error) {
      // invoke no trae el cuerpo de un 4xx: hay que leerlo de la respuesta.
      var texto = '';
      try { texto = (await r.error.context.json()).error; } catch (e) { /* sin cuerpo */ }
      throw new Error(texto || r.error.message || 'No se pudo completar la operación.');
    }
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data;
  }

  /**
   * Solicitud de acceso. Deja el perfil en "pendiente": el administrador debe
   * aprobarlo y asignarle municipios antes de que pueda entrar.
   * Devuelve { estado, cuenta_nueva } o { ya_existe: true, estado }.
   */
  function registrarse(datos) {
    return llamar('solicitar', {
      email: datos.email, nombre: datos.nombre, clave: datos.clave,
      cargo: datos.cargo, telefono: datos.telefono, municipio: datos.municipio
    });
  }

  /** Alta desde el panel de administración. Devuelve la clave provisional. */
  function crearUsuario(datos)  { return llamar('crear', datos); }

  /** Clave provisional nueva para quien la perdió. */
  function reiniciarClave(id)   { return llamar('clave', { id: id }); }

  /** Rol, estado y municipios en una sola operación, con sus validaciones. */
  function fijarAcceso(datos)   { return llamar('estado', datos); }

  /**
   * Olvidé mi contraseña. Deja la solicitud en la bandeja del administrador;
   * no envía ningún correo. El enlace de Supabase llegaba a buzones
   * institucionales que nadie revisa y caducaba antes de que lo abrieran.
   *
   * La respuesta es siempre la misma, exista o no la cuenta.
   */
  function recuperar(email) { return llamar('olvide', { email: email }); }

  /**
   * Cambio de contraseña por la propia persona. Al guardarla deja de ser
   * provisional: es lo que levanta la obligación de cambiarla al entrar.
   */
  async function cambiarClave(nueva) {
    var r = await sb.auth.updateUser({ password: nueva });
    if (r.error) throw r.error;

    var s = await sb.auth.getSession();
    var uid = s.data && s.data.session && s.data.session.user.id;
    if (!uid) return;
    await sb.from('dnt_perfiles').update({
      clave_provisional: false,
      clave_cambiada_en: new Date().toISOString()
    }).eq('id', uid);
    if (_sesion) {
      _sesion.debeCambiarClave = false;
      if (_sesion.usuario) _sesion.usuario.clave_provisional = false;
    }
  }

  async function salir() {
    await sb.auth.signOut();
    _sesion = null;
    location.href = urlLogin();
  }

  /** Auditoría (E39). Nunca interrumpe el flujo del usuario. */
  function registrar(evento, detalle) {
    var u = usuario();
    if (!u) return;
    var d = detalle || {};
    sb.from('dnt_log').insert({
      usuario_id: u.id,
      evento: evento,
      entidad: d.entidad || null,
      entidad_id: d.entidad_id || null,
      caso_id: d.caso_id || null,
      municipio: d.municipio || null,
      detalle: d.detalle || {}
    }).then(function () {}, function () {});
  }

  global.DNTAuth = {
    sb: sb, verificar: verificar, sesion: sesion, usuario: usuario, rol: rol,
    esAdmin: esAdmin, esCoord: esCoord, esResp: esResp, veTodo: veTodo,
    alcance: alcance, municipios: municipios, nombreMunicipio: nombreMunicipio,
    puedeVer: puedeVer, puedeEditar: puedeEditar,
    puedeCerrarCasos: puedeCerrarCasos, puedeEliminar: puedeEliminar,
    ingresar: ingresar, registrarse: registrarse, recuperar: recuperar,
    cambiarClave: cambiarClave, salir: salir, registrar: registrar,
    crearUsuario: crearUsuario, reiniciarClave: reiniciarClave, fijarAcceso: fijarAcceso
  };
})(window);
