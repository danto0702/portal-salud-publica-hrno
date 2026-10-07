-- ═══════════════════════════════════════════════════════════════════
-- Seguimiento de Cuentas de Cobro · Salud Pública HRNO
-- Proyecto Supabase: wttljozqyaxlzilomnef (mismo del portal)
--
-- Flujo obligatorio de cada cuenta (una cuenta = un pago del contrato):
--   contratista → salud_publica → contratacion → subgerencia
--   → secop → supervision → tesoreria → pagada
-- Cualquier proceso puede devolver al contratista o a un proceso anterior
-- (con motivo y fecha). Cada llegada/salida queda en cc_movimientos.
--
-- Los cambios de etapa y los datos propios de cada proceso SOLO se hacen
-- por las funciones cc_mover / cc_mover_lote / cc_datos, que validan el rol
-- del usuario y el orden. Un trigger impide saltarse esas funciones.
-- ═══════════════════════════════════════════════════════════════════

-- ── Usuarios del módulo (proceso que edita cada uno) ────────────────
create table if not exists public.cc_usuarios (
  usuario_id      uuid primary key references public.portal_usuarios(id) on delete cascade,
  nombre_completo text not null,
  cargo           text,
  proceso         text not null check (proceso in ('salud_publica','contratacion','subgerencia','tesoreria','lector')),
  activo          boolean not null default true,
  creado_en       timestamptz not null default now()
);

-- ── Contratos ───────────────────────────────────────────────────────
create table if not exists public.cc_contratos (
  id               uuid primary key default gen_random_uuid(),
  vigencia         int  not null default 2026,
  numero_contrato  text not null,
  programa         text not null,
  resolucion       text,
  cedula           text not null,
  nombre           text not null,
  rol              text,
  municipio        text,
  objeto           text,
  valor_total      numeric not null default 0,
  tiempo_ejec      int,
  fecha_acta       date,
  correo           text,
  telefono         text,
  activo           boolean not null default true,
  origen           text not null default 'manual',
  notas            text,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now(),
  unique (vigencia, numero_contrato)
);
create index if not exists cc_contratos_cedula_idx   on public.cc_contratos (cedula);
create index if not exists cc_contratos_programa_idx on public.cc_contratos (programa);

-- ── Cuentas (un registro por pago) ──────────────────────────────────
create table if not exists public.cc_cuentas (
  id              uuid primary key default gen_random_uuid(),
  contrato_id     uuid not null references public.cc_contratos(id) on delete cascade,
  num_pago        int  not null,
  periodo_ini     date,
  periodo_fin     date,
  valor           numeric not null default 0,
  -- flujo
  etapa           text not null default 'contratista',
  etapa_desde     timestamptz not null default now(),
  devuelta_desde  text,          -- etapa que la devolvió al contratista
  motivo_ult_dev  text,
  devoluciones    int  not null default 0,
  -- 1er filtro Salud Pública
  sp_estado       text not null default 'Pendiente',
  sp_fecha        date,
  -- 2do filtro Contratación
  ct_estado       text not null default 'Pendiente',
  ct_fecha        date,
  -- 3er filtro Subgerencia
  sg_estado       text not null default 'Pendiente',
  sg_fecha        date,
  radicado        text,
  factura         text,
  -- SECOP II (lo registra Subgerencia)
  secop_estado    text not null default 'Pendiente',
  secop_fecha     date,
  -- Supervisión (Subgerencia)
  sup_estado      text not null default 'Pendiente',
  sup_fecha       date,
  -- Tesorería
  tes_estado      text not null default 'No pagado',
  tes_valor       numeric,
  tes_fecha       date,
  nd              text,
  observaciones   text,
  actualizado_en  timestamptz not null default now(),
  actualizado_por text,
  unique (contrato_id, num_pago),
  check (etapa in ('contratista','salud_publica','contratacion','subgerencia','secop','supervision','tesoreria','pagada')),
  check (sp_estado  in ('Pendiente','Aprobado','Devuelto')),
  check (ct_estado  in ('Pendiente','Aprobado','Devuelto')),
  check (sg_estado  in ('Pendiente','Aprobado','Devuelto')),
  check (sup_estado in ('Pendiente','Aprobado','Devuelto')),
  check (secop_estado in ('Pendiente','Publicado','Aprobado','Devuelto')),
  check (tes_estado in ('No pagado','Pagado','Devuelto'))
);
create index if not exists cc_cuentas_etapa_idx on public.cc_cuentas (etapa);

-- ── Historial de movimientos ────────────────────────────────────────
create table if not exists public.cc_movimientos (
  id              uuid primary key default gen_random_uuid(),
  cuenta_id       uuid not null references public.cc_cuentas(id) on delete cascade,
  accion          text not null,  -- recibir | aprobar | devolver | datos | pagar | mover_admin | editar
  etapa_origen    text,
  etapa_destino   text,
  fecha           timestamptz not null default now(),  -- fecha del hecho (editable)
  motivo          text,
  detalle         jsonb not null default '{}'::jsonb,
  usuario_id      uuid default auth.uid(),
  usuario_nombre  text,
  usuario_proceso text,
  creado_en       timestamptz not null default now()
);
create index if not exists cc_mov_cuenta_idx on public.cc_movimientos (cuenta_id, fecha);

-- ── Configuración (umbrales del semáforo, programas, historial de cargues) ──
create table if not exists public.cc_config (
  clave          text primary key,
  valor          jsonb not null default '{}'::jsonb,
  actualizado_en timestamptz not null default now()
);
insert into public.cc_config (clave, valor) values
  ('umbrales', '{"contratista":5,"salud_publica":3,"contratacion":3,"subgerencia":3,"secop":5,"supervision":3,"tesoreria":5}'),
  ('programas', '["EBS","Jóvenes en Paz","PIC Departamental","PIC Municipal","Vacunación"]'),
  ('cargues_historial', '{"items":[]}')
on conflict (clave) do nothing;

-- ═══════════════════════════════════════════════════════════════════
-- Funciones de apoyo
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.cc_proceso() returns text
language sql stable security definer set search_path = public as $$
  select case when public.es_superadmin() then 'superadmin'
              else (select proceso from public.cc_usuarios where usuario_id = auth.uid() and activo) end;
$$;

create or replace function public.cc_puede_ver() returns boolean
language sql stable security definer set search_path = public as $$
  select public.cc_proceso() is not null;
$$;

-- Salud Pública gestiona contratos y el plan de pagos (además del superadmin)
create or replace function public.cc_puede_gestionar() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cc_proceso() in ('superadmin','salud_publica'), false);
$$;

create or replace function public.cc_orden(e text) returns int
language sql immutable as $$
  select case e when 'contratista' then 0 when 'salud_publica' then 1 when 'contratacion' then 2
    when 'subgerencia' then 3 when 'secop' then 4 when 'supervision' then 5
    when 'tesoreria' then 6 when 'pagada' then 7 end;
$$;

create or replace function public.cc_siguiente(e text) returns text
language sql immutable as $$
  select case e when 'contratista' then 'salud_publica' when 'salud_publica' then 'contratacion'
    when 'contratacion' then 'subgerencia' when 'subgerencia' then 'secop' when 'secop' then 'supervision'
    when 'supervision' then 'tesoreria' when 'tesoreria' then 'pagada' end;
$$;

-- Proceso responsable de cada etapa
create or replace function public.cc_dueno(e text, devuelta_desde text) returns text
language sql immutable as $$
  -- si está en el contratista, responde quien la devolvió (o Salud Pública si nunca ha entrado)
  select case case when e = 'contratista' then coalesce(devuelta_desde, 'salud_publica') else e end
    when 'salud_publica' then 'salud_publica'
    when 'contratacion'  then 'contratacion'
    when 'subgerencia'   then 'subgerencia'
    when 'secop'         then 'subgerencia'
    when 'supervision'   then 'subgerencia'
    when 'tesoreria'     then 'tesoreria' end;
$$;

-- Prefijo de columnas de estado por etapa
create or replace function public.cc_pref(e text) returns text
language sql immutable as $$
  select case e when 'salud_publica' then 'sp' when 'contratacion' then 'ct' when 'subgerencia' then 'sg'
    when 'secop' then 'secop' when 'supervision' then 'sup' when 'tesoreria' then 'tes' end;
$$;

-- ── Guardia: el flujo solo se modifica por las funciones cc_* ───────
create or replace function public.cc_guard_cuentas() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('cc.rpc', true), '') = '1' or public.es_superadmin() then
    return new;
  end if;
  if (new.etapa, new.etapa_desde, new.devuelta_desde, new.devoluciones,
      new.sp_estado, new.sp_fecha, new.ct_estado, new.ct_fecha,
      new.sg_estado, new.sg_fecha, new.radicado, new.factura,
      new.secop_estado, new.secop_fecha, new.sup_estado, new.sup_fecha,
      new.tes_estado, new.tes_valor, new.tes_fecha, new.nd)
     is distinct from
     (old.etapa, old.etapa_desde, old.devuelta_desde, old.devoluciones,
      old.sp_estado, old.sp_fecha, old.ct_estado, old.ct_fecha,
      old.sg_estado, old.sg_fecha, old.radicado, old.factura,
      old.secop_estado, old.secop_fecha, old.sup_estado, old.sup_fecha,
      old.tes_estado, old.tes_valor, old.tes_fecha, old.nd) then
    raise exception 'Los datos del flujo solo se modifican desde las acciones de cada proceso';
  end if;
  return new;
end $$;
drop trigger if exists cc_guard_cuentas on public.cc_cuentas;
create trigger cc_guard_cuentas before update on public.cc_cuentas
  for each row execute function public.cc_guard_cuentas();

-- ═══════════════════════════════════════════════════════════════════
-- cc_mover: recibir / aprobar / devolver / pagar / mover_admin
--   p_datos admite: radicado, factura (Subgerencia) · tes_valor, nd (Tesorería)
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.cc_mover(
  p_cuenta  uuid,
  p_accion  text,
  p_destino text default null,
  p_fecha   timestamptz default null,
  p_motivo  text default null,
  p_datos   jsonb default '{}'::jsonb
) returns public.cc_cuentas
language plpgsql security definer set search_path = public as $$
declare
  c        public.cc_cuentas;
  yo       text := public.cc_proceso();
  nom      text;
  f        timestamptz := coalesce(p_fecha, now());
  fd       date := (coalesce(p_fecha, now()) at time zone 'America/Bogota')::date;
  origen   text;
  destino  text;
  pref     text;
  et       text;
begin
  if yo is null or yo = 'lector' then raise exception 'No tiene permisos para modificar cuentas'; end if;
  select * into c from public.cc_cuentas where id = p_cuenta for update;
  if not found then raise exception 'Cuenta no encontrada'; end if;
  origen := c.etapa;

  if yo <> 'superadmin' and public.cc_dueno(c.etapa, c.devuelta_desde) <> yo then
    raise exception 'Esta cuenta está en % y no le corresponde a su proceso', c.etapa;
  end if;

  select coalesce(nombre_completo, '') into nom from public.cc_usuarios where usuario_id = auth.uid();
  if nom is null or nom = '' then select nombre into nom from public.portal_usuarios where id = auth.uid(); end if;

  perform set_config('cc.rpc', '1', true);

  if p_accion = 'recibir' then
    -- el contratista entrega (o reenvía tras devolución) la cuenta
    if c.etapa <> 'contratista' then raise exception 'La cuenta no está en manos del contratista'; end if;
    destino := coalesce(c.devuelta_desde, 'salud_publica');
    pref := public.cc_pref(destino);
    execute format('update public.cc_cuentas set %I = %L where id = %L',
      pref || '_estado', case when destino = 'tesoreria' then 'No pagado' else 'Pendiente' end, c.id);
    update public.cc_cuentas set etapa = destino, etapa_desde = f, devuelta_desde = null where id = c.id;

  elsif p_accion = 'aprobar' then
    if c.etapa in ('contratista','tesoreria','pagada') then
      raise exception 'Acción no válida para la etapa %', c.etapa;
    end if;
    if c.etapa = 'subgerencia' then
      if coalesce(nullif(p_datos->>'radicado',''), c.radicado) is null
         or coalesce(nullif(p_datos->>'factura',''), c.factura) is null then
        raise exception 'Subgerencia debe registrar el número de radicado y de factura electrónica antes de aprobar';
      end if;
      update public.cc_cuentas set
        radicado = coalesce(nullif(p_datos->>'radicado',''), radicado),
        factura  = coalesce(nullif(p_datos->>'factura',''), factura)
      where id = c.id;
    end if;
    destino := public.cc_siguiente(c.etapa);
    pref := public.cc_pref(c.etapa);
    execute format('update public.cc_cuentas set %I = ''Aprobado'', %I = %L where id = %L',
      pref || '_estado', pref || '_fecha', fd, c.id);
    update public.cc_cuentas set etapa = destino, etapa_desde = f where id = c.id;

  elsif p_accion = 'pagar' then
    if c.etapa <> 'tesoreria' then raise exception 'Solo se paga desde Tesorería'; end if;
    if nullif(p_datos->>'nd','') is null or nullif(p_datos->>'tes_valor','') is null then
      raise exception 'Tesorería debe registrar el valor pagado y el número ND (certificado de egreso)';
    end if;
    destino := 'pagada';
    update public.cc_cuentas set tes_estado = 'Pagado', tes_fecha = fd,
      tes_valor = (p_datos->>'tes_valor')::numeric, nd = p_datos->>'nd',
      etapa = destino, etapa_desde = f where id = c.id;

  elsif p_accion = 'devolver' then
    if nullif(trim(coalesce(p_motivo,'')),'') is null then raise exception 'El motivo de devolución es obligatorio'; end if;
    if c.etapa in ('contratista','pagada') then raise exception 'No se puede devolver desde %', c.etapa; end if;
    destino := coalesce(p_destino, 'contratista');
    if public.cc_orden(destino) is null or public.cc_orden(destino) >= public.cc_orden(c.etapa) then
      raise exception 'Solo se puede devolver al contratista o a un proceso anterior';
    end if;
    pref := public.cc_pref(c.etapa);
    execute format('update public.cc_cuentas set %I = ''Devuelto'', %I = %L where id = %L',
      pref || '_estado', pref || '_fecha', fd, c.id);
    if destino = 'contratista' then
      update public.cc_cuentas set etapa = 'contratista', etapa_desde = f, devuelta_desde = c.etapa,
        devoluciones = devoluciones + 1, motivo_ult_dev = p_motivo where id = c.id;
    else
      execute format('update public.cc_cuentas set %I = ''Pendiente'' where id = %L',
        public.cc_pref(destino) || '_estado', c.id);
      -- los procesos intermedios deberán revisar de nuevo
      foreach et in array array['contratacion','subgerencia','secop','supervision'] loop
        if public.cc_orden(et) > public.cc_orden(destino) and public.cc_orden(et) < public.cc_orden(c.etapa) then
          execute format('update public.cc_cuentas set %I = ''Pendiente'' where id = %L', public.cc_pref(et) || '_estado', c.id);
        end if;
      end loop;
      update public.cc_cuentas set etapa = destino, etapa_desde = f, devuelta_desde = null,
        devoluciones = devoluciones + 1, motivo_ult_dev = p_motivo where id = c.id;
    end if;

  elsif p_accion = 'mover_admin' then
    if yo <> 'superadmin' then raise exception 'Solo el superadministrador puede mover libremente'; end if;
    destino := p_destino;
    if public.cc_orden(destino) is null then raise exception 'Etapa destino no válida'; end if;
    update public.cc_cuentas set etapa = destino, etapa_desde = f,
      devuelta_desde = case when destino = 'contratista' then devuelta_desde else null end where id = c.id;
  else
    raise exception 'Acción desconocida: %', p_accion;
  end if;

  update public.cc_cuentas set actualizado_en = now(), actualizado_por = nom where id = c.id;

  insert into public.cc_movimientos (cuenta_id, accion, etapa_origen, etapa_destino, fecha, motivo, detalle, usuario_nombre, usuario_proceso)
  values (c.id, p_accion, origen, destino, f, p_motivo, coalesce(p_datos, '{}'::jsonb), nom, yo);

  perform set_config('cc.rpc', '', true);
  select * into c from public.cc_cuentas where id = p_cuenta;
  return c;
end $$;

-- Lote: devuelve cuántas se movieron y los errores por cuenta
create or replace function public.cc_mover_lote(
  p_cuentas uuid[], p_accion text, p_destino text default null,
  p_fecha timestamptz default null, p_motivo text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i uuid; ok int := 0; errs jsonb := '[]'::jsonb;
begin
  foreach i in array p_cuentas loop
    begin
      perform public.cc_mover(i, p_accion, p_destino, p_fecha, p_motivo, '{}'::jsonb);
      ok := ok + 1;
    exception when others then
      errs := errs || jsonb_build_object('id', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('ok', ok, 'errores', errs);
end $$;

-- ═══════════════════════════════════════════════════════════════════
-- cc_datos: cada proceso edita solo sus propios campos (sin mover la cuenta)
--   subgerencia: radicado, factura, secop_estado, sup_estado (+ fechas)
--   tesoreria:   tes_valor, tes_fecha, nd, tes_estado
--   salud_publica/contratacion: su fecha de filtro
-- ═══════════════════════════════════════════════════════════════════
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
    when 'superadmin'    then array['sp_fecha','ct_fecha','sg_fecha','radicado','factura','secop_estado','secop_fecha','sup_estado','sup_fecha','tes_estado','tes_valor','tes_fecha','nd','sp_estado','ct_estado','sg_estado','observaciones']
    when 'salud_publica' then array['sp_fecha','observaciones']
    when 'contratacion'  then array['ct_fecha']
    when 'subgerencia'   then array['sg_fecha','radicado','factura','secop_estado','secop_fecha','sup_fecha']
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
    actualizado_en = now(), actualizado_por = nom
  where id = c.id;

  insert into public.cc_movimientos (cuenta_id, accion, etapa_origen, etapa_destino, motivo, detalle, usuario_nombre, usuario_proceso)
  values (c.id, 'datos', c.etapa, c.etapa, p_motivo, p_datos, nom, yo);

  perform set_config('cc.rpc', '', true);
  select * into c from public.cc_cuentas where id = p_cuenta;
  return c;
end $$;

-- ═══════════════════════════════════════════════════════════════════
-- Consulta pública por cédula (página del contratista, sin sesión)
-- Solo devuelve el estado de sus propias cuentas.
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.cc_consulta_publica(p_cedula text)
returns table (
  numero_contrato text, programa text, nombre text, num_pago int,
  periodo_ini date, periodo_fin date, valor numeric, etapa text, etapa_desde timestamptz,
  motivo_ult_dev text, tes_estado text, tes_fecha date, radicado text
)
language sql stable security definer set search_path = public as $$
  select k.numero_contrato, k.programa,
         -- solo iniciales del nombre para no exponer datos completos
         regexp_replace(k.nombre, '(\S)\S*', '\1.', 'g'),
         c.num_pago, c.periodo_ini, c.periodo_fin, c.valor, c.etapa, c.etapa_desde,
         case when c.etapa = 'contratista' then c.motivo_ult_dev end,
         c.tes_estado, c.tes_fecha, c.radicado
  from public.cc_cuentas c join public.cc_contratos k on k.id = c.contrato_id
  where length(regexp_replace(coalesce(p_cedula,''), '\D', '', 'g')) >= 5
    and k.cedula = regexp_replace(p_cedula, '\D', '', 'g')
    and k.activo
  order by k.numero_contrato, c.num_pago;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════════
alter table public.cc_usuarios    enable row level security;
alter table public.cc_contratos   enable row level security;
alter table public.cc_cuentas     enable row level security;
alter table public.cc_movimientos enable row level security;
alter table public.cc_config      enable row level security;

drop policy if exists cc_usuarios_sel on public.cc_usuarios;
create policy cc_usuarios_sel on public.cc_usuarios for select using (public.cc_puede_ver() or usuario_id = auth.uid());
drop policy if exists cc_usuarios_adm on public.cc_usuarios;
create policy cc_usuarios_adm on public.cc_usuarios for all using (public.es_superadmin()) with check (public.es_superadmin());

drop policy if exists cc_contratos_sel on public.cc_contratos;
create policy cc_contratos_sel on public.cc_contratos for select using (public.cc_puede_ver());
drop policy if exists cc_contratos_ins on public.cc_contratos;
create policy cc_contratos_ins on public.cc_contratos for insert with check (public.cc_puede_gestionar());
drop policy if exists cc_contratos_upd on public.cc_contratos;
create policy cc_contratos_upd on public.cc_contratos for update using (public.cc_puede_gestionar()) with check (public.cc_puede_gestionar());
drop policy if exists cc_contratos_del on public.cc_contratos;
create policy cc_contratos_del on public.cc_contratos for delete using (public.es_superadmin());

drop policy if exists cc_cuentas_sel on public.cc_cuentas;
create policy cc_cuentas_sel on public.cc_cuentas for select using (public.cc_puede_ver());
drop policy if exists cc_cuentas_ins on public.cc_cuentas;
create policy cc_cuentas_ins on public.cc_cuentas for insert with check (public.cc_puede_gestionar());
drop policy if exists cc_cuentas_upd on public.cc_cuentas;
create policy cc_cuentas_upd on public.cc_cuentas for update using (public.cc_puede_gestionar()) with check (public.cc_puede_gestionar());
drop policy if exists cc_cuentas_del on public.cc_cuentas;
create policy cc_cuentas_del on public.cc_cuentas for delete using (public.cc_puede_gestionar() and etapa = 'contratista' and sp_estado = 'Pendiente');

drop policy if exists cc_mov_sel on public.cc_movimientos;
create policy cc_mov_sel on public.cc_movimientos for select using (public.cc_puede_ver());
drop policy if exists cc_mov_ins on public.cc_movimientos;
create policy cc_mov_ins on public.cc_movimientos for insert with check (public.cc_puede_gestionar());

drop policy if exists cc_config_sel on public.cc_config;
create policy cc_config_sel on public.cc_config for select using (public.cc_puede_ver());
drop policy if exists cc_config_upd on public.cc_config;
create policy cc_config_upd on public.cc_config for all using (public.cc_puede_gestionar()) with check (public.cc_puede_gestionar());

revoke all on function public.cc_mover(uuid,text,text,timestamptz,text,jsonb) from anon, public;
revoke all on function public.cc_mover_lote(uuid[],text,text,timestamptz,text) from anon, public;
revoke all on function public.cc_datos(uuid,jsonb,text) from anon, public;
grant execute on function public.cc_mover(uuid,text,text,timestamptz,text,jsonb) to authenticated;
grant execute on function public.cc_mover_lote(uuid[],text,text,timestamptz,text) to authenticated;
grant execute on function public.cc_datos(uuid,jsonb,text) to authenticated;
grant execute on function public.cc_consulta_publica(text) to anon, authenticated;

-- Módulo en el portal
insert into public.portal_modulos (id, nombre, padre_id, es_publico, tiene_admin_propio, orden)
values ('cuentas_cobro', 'Seguimiento de Cuentas de Cobro', null, false, true, 90)
on conflict (id) do nothing;

-- ── Endurecimiento (advertencias del linter de Supabase) ────────────
alter function public.cc_orden(text) set search_path = public;
alter function public.cc_siguiente(text) set search_path = public;
alter function public.cc_pref(text) set search_path = public;
alter function public.cc_dueno(text, text) set search_path = public;
alter function public.cc_guard_cuentas() set search_path = public;
revoke execute on function public.cc_proceso() from anon, public;
revoke execute on function public.cc_puede_ver() from anon, public;
revoke execute on function public.cc_puede_gestionar() from anon, public;
grant execute on function public.cc_proceso() to authenticated;
grant execute on function public.cc_puede_ver() to authenticated;
grant execute on function public.cc_puede_gestionar() to authenticated;
