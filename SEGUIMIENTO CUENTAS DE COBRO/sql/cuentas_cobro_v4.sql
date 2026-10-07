-- ═══════════════════════════════════════════════════════════════════
-- Seguimiento de Cuentas de Cobro · cambios v4 (02/10/2026)
--  Datos exclusivos de Subgerencia, editables en cualquier etapa:
--   · radicado (ya existía; ahora con su propio recuadro)
--   · sg_notif_fecha: fecha de notificación al contratista. Al registrarla
--     marca sg_notificado; al borrarla lo desmarca.
--  Solo Subgerencia y el superadministrador pueden escribirlos (cc_datos).
-- ═══════════════════════════════════════════════════════════════════

alter table public.cc_cuentas add column if not exists sg_notif_fecha date;

create or replace function public.cc_guard_cuentas() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('cc.rpc', true), '') = '1' or public.es_superadmin() then
    return new;
  end if;
  if (new.etapa, new.etapa_desde, new.devuelta_desde, new.devoluciones,
      new.sp_estado, new.sp_fecha, new.ct_estado, new.ct_fecha,
      new.sg_estado, new.sg_fecha, new.radicado, new.factura,
      new.secop_estado, new.secop_fecha, new.sup_estado, new.sup_fecha,
      new.tes_estado, new.tes_valor, new.tes_fecha, new.nd,
      new.sg_notificado, new.sg_presupuesto, new.sg_correo, new.sg_notif_fecha)
     is distinct from
     (old.etapa, old.etapa_desde, old.devuelta_desde, old.devoluciones,
      old.sp_estado, old.sp_fecha, old.ct_estado, old.ct_fecha,
      old.sg_estado, old.sg_fecha, old.radicado, old.factura,
      old.secop_estado, old.secop_fecha, old.sup_estado, old.sup_fecha,
      old.tes_estado, old.tes_valor, old.tes_fecha, old.nd,
      old.sg_notificado, old.sg_presupuesto, old.sg_correo, old.sg_notif_fecha) then
    raise exception 'Los datos del flujo solo se modifican desde las acciones de cada proceso';
  end if;
  return new;
end $$;

create or replace function public.cc_datos(p_cuenta uuid, p_datos jsonb, p_motivo text default null)
returns public.cc_cuentas
language plpgsql security definer set search_path = public as $$
declare
  c   public.cc_cuentas;
  yo  text := public.cc_proceso();
  nom text;
  k   text;
  permitidos text[];
begin
  if yo is null or yo = 'lector' then raise exception 'No tiene permisos para modificar cuentas'; end if;
  select * into c from public.cc_cuentas where id = p_cuenta for update;
  if not found then raise exception 'Cuenta no encontrada'; end if;

  permitidos := case yo
    when 'superadmin'    then array['sp_fecha','ct_fecha','sg_fecha','radicado','factura','secop_estado','secop_fecha','sup_estado','sup_fecha','tes_estado','tes_valor','tes_fecha','nd','sp_estado','ct_estado','sg_estado','observaciones','sg_notificado','sg_presupuesto','sg_correo','sg_notif_fecha']
    when 'salud_publica' then array['sp_fecha','observaciones']
    when 'contratacion'  then array['ct_fecha']
    when 'subgerencia'   then array['sg_fecha','radicado','factura','secop_estado','secop_fecha','sup_fecha','sg_notificado','sg_presupuesto','sg_correo','sg_notif_fecha']
    when 'tesoreria'     then array['tes_valor','tes_fecha','nd']
  end;
  for k in select jsonb_object_keys(p_datos) loop
    if not (k = any(permitidos)) then raise exception 'Su proceso no puede editar el campo %', k; end if;
  end loop;
  if p_datos ? 'secop_estado' and (p_datos->>'secop_estado') not in ('Pendiente','Publicado','Aprobado') then
    raise exception 'Estado SECOP no válido';
  end if;

  select coalesce(nombre_completo, '') into nom from public.cc_usuarios where usuario_id = auth.uid();
  if nom is null or nom = '' then select nombre into nom from public.portal_usuarios where id = auth.uid(); end if;

  perform set_config('cc.rpc', '1', true);
  update public.cc_cuentas set
    sp_fecha     = case when p_datos ? 'sp_fecha'     then nullif(p_datos->>'sp_fecha','')::date     else sp_fecha end,
    ct_fecha     = case when p_datos ? 'ct_fecha'     then nullif(p_datos->>'ct_fecha','')::date     else ct_fecha end,
    sg_fecha     = case when p_datos ? 'sg_fecha'     then nullif(p_datos->>'sg_fecha','')::date     else sg_fecha end,
    sp_estado    = case when p_datos ? 'sp_estado'    then p_datos->>'sp_estado'    else sp_estado end,
    ct_estado    = case when p_datos ? 'ct_estado'    then p_datos->>'ct_estado'    else ct_estado end,
    sg_estado    = case when p_datos ? 'sg_estado'    then p_datos->>'sg_estado'    else sg_estado end,
    radicado     = case when p_datos ? 'radicado'     then nullif(p_datos->>'radicado','')     else radicado end,
    factura      = case when p_datos ? 'factura'      then nullif(p_datos->>'factura','')      else factura end,
    secop_estado = case when p_datos ? 'secop_estado' then p_datos->>'secop_estado' else secop_estado end,
    secop_fecha  = case when p_datos ? 'secop_fecha'  then nullif(p_datos->>'secop_fecha','')::date  else secop_fecha end,
    sup_estado   = case when p_datos ? 'sup_estado'   then p_datos->>'sup_estado'   else sup_estado end,
    sup_fecha    = case when p_datos ? 'sup_fecha'    then nullif(p_datos->>'sup_fecha','')::date    else sup_fecha end,
    tes_estado   = case when p_datos ? 'tes_estado'   then p_datos->>'tes_estado'   else tes_estado end,
    tes_valor    = case when p_datos ? 'tes_valor'    then nullif(p_datos->>'tes_valor','')::numeric else tes_valor end,
    tes_fecha    = case when p_datos ? 'tes_fecha'    then nullif(p_datos->>'tes_fecha','')::date    else tes_fecha end,
    nd           = case when p_datos ? 'nd'           then nullif(p_datos->>'nd','')           else nd end,
    observaciones= case when p_datos ? 'observaciones' then p_datos->>'observaciones' else observaciones end,
    sg_notif_fecha = case when p_datos ? 'sg_notif_fecha' then nullif(p_datos->>'sg_notif_fecha','')::date else sg_notif_fecha end,
    -- la fecha de notificación manda sobre la casilla
    sg_notificado  = case when p_datos ? 'sg_notif_fecha' then nullif(p_datos->>'sg_notif_fecha','') is not null
                          when p_datos ? 'sg_notificado'  then (p_datos->>'sg_notificado')::boolean else sg_notificado end,
    sg_presupuesto = case when p_datos ? 'sg_presupuesto' then (p_datos->>'sg_presupuesto')::boolean else sg_presupuesto end,
    sg_correo      = case when p_datos ? 'sg_correo'      then (p_datos->>'sg_correo')::boolean      else sg_correo end,
    actualizado_en = now(), actualizado_por = nom
  where id = c.id;

  insert into public.cc_movimientos (cuenta_id, accion, etapa_origen, etapa_destino, motivo, detalle, usuario_nombre, usuario_proceso)
  values (c.id, 'datos', c.etapa, c.etapa, p_motivo, p_datos, nom, yo);

  perform set_config('cc.rpc', '', true);
  select * into c from public.cc_cuentas where id = p_cuenta;
  return c;
end $$;
