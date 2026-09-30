-- ═══════════════════════════════════════════════════════════════════
-- Seguimiento de Cuentas de Cobro · cambios v3 (30/09/2026)
--  1. Liquidación de contratos (personal que no cumple): valor específico,
--     puede ser $0. El valor queda como una cuenta final que recorre el flujo;
--     los demás pagos no entregados se anulan. La hacen el superadmin y
--     Contratación; solo el superadmin la revierte.
--  2. Borrado de certificados de cumplimiento EBS (certeb_emitidos) por el
--     superadmin. El número no se reutiliza: queda en certeb_anulados.
-- ═══════════════════════════════════════════════════════════════════

alter table public.cc_contratos
  add column if not exists liquidado  boolean not null default false,
  add column if not exists liq_fecha  date,
  add column if not exists liq_valor  numeric,
  add column if not exists liq_motivo text,
  add column if not exists liq_por    text,
  add column if not exists liq_en     timestamptz;

alter table public.cc_cuentas
  add column if not exists es_liquidacion boolean not null default false;

alter table public.cc_cuentas drop constraint if exists cc_cuentas_etapa_check;
alter table public.cc_cuentas add constraint cc_cuentas_etapa_check
  check (etapa in ('contratista','salud_publica','contratacion','subgerencia','supervision','secop','tesoreria','pagada','anulada'));

-- Nombre visible de quien llama (para el historial)
create or replace function public.cc_nombre_actual() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select nombre_completo from public.cc_usuarios where usuario_id = auth.uid()), ''),
                  (select nombre from public.portal_usuarios where id = auth.uid()), 'Sistema');
$$;

-- ── Liquidar contrato ───────────────────────────────────────────────
create or replace function public.cc_liquidar(p_contrato uuid, p_fecha date, p_valor numeric, p_motivo text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  yo text := public.cc_proceso();
  nom text := public.cc_nombre_actual();
  k public.cc_contratos;
  c record;
  liq uuid;
  anuladas int := 0;
  creada boolean := false;
  mx int;
  ult date;
begin
  if yo is null or yo not in ('superadmin','contratacion') then
    raise exception 'Solo el superadministrador o Contratación pueden liquidar contratos';
  end if;
  if p_fecha is null then raise exception 'La fecha de liquidación es obligatoria'; end if;
  if p_valor is null or p_valor < 0 then raise exception 'El valor de liquidación no es válido'; end if;
  if nullif(trim(coalesce(p_motivo,'')),'') is null then raise exception 'El motivo de la liquidación es obligatorio'; end if;

  select * into k from public.cc_contratos where id = p_contrato for update;
  if not found then raise exception 'Contrato no encontrado'; end if;
  if k.liquidado then raise exception 'El contrato ya está liquidado'; end if;

  perform set_config('cc.rpc', '1', true);

  -- pagos que el contratista no ha entregado (sin ningún movimiento)
  for c in
    select cu.* from public.cc_cuentas cu
     where cu.contrato_id = p_contrato and cu.etapa = 'contratista' and cu.devuelta_desde is null
       and not exists (select 1 from public.cc_movimientos m where m.cuenta_id = cu.id)
     order by cu.num_pago
  loop
    if liq is null and p_valor > 0 then
      update public.cc_cuentas set es_liquidacion = true, valor = p_valor,
        periodo_ini = least(coalesce(periodo_ini, p_fecha), p_fecha), periodo_fin = p_fecha,
        actualizado_en = now(), actualizado_por = nom
       where id = c.id;
      insert into public.cc_movimientos (cuenta_id, accion, etapa_origen, etapa_destino, motivo, detalle, usuario_nombre, usuario_proceso)
      values (c.id, 'liquidacion', 'contratista', 'contratista', 'Cuenta de liquidación: ' || p_motivo,
        jsonb_build_object('valor_anterior', c.valor, 'periodo_ini_anterior', c.periodo_ini, 'periodo_fin_anterior', c.periodo_fin,
                           'valor_liquidacion', p_valor, 'fecha_liquidacion', p_fecha), nom, yo);
      liq := c.id;
    else
      update public.cc_cuentas set etapa = 'anulada', etapa_desde = now(), actualizado_en = now(), actualizado_por = nom
       where id = c.id;
      insert into public.cc_movimientos (cuenta_id, accion, etapa_origen, etapa_destino, motivo, detalle, usuario_nombre, usuario_proceso)
      values (c.id, 'anular', 'contratista', 'anulada', 'Anulada por liquidación del contrato: ' || p_motivo,
        jsonb_build_object('valor', c.valor), nom, yo);
      anuladas := anuladas + 1;
    end if;
  end loop;

  -- si hay valor pero no quedaba ningún pago libre, se crea la cuenta de liquidación
  if p_valor > 0 and liq is null then
    select coalesce(max(num_pago), 0), max(periodo_fin) into mx, ult from public.cc_cuentas where contrato_id = p_contrato;
    insert into public.cc_cuentas (contrato_id, num_pago, periodo_ini, periodo_fin, valor, es_liquidacion, actualizado_por)
    values (p_contrato, mx + 1, least(coalesce(ult + 1, p_fecha), p_fecha), p_fecha, p_valor, true, nom)
    returning id into liq;
    insert into public.cc_movimientos (cuenta_id, accion, etapa_origen, etapa_destino, motivo, detalle, usuario_nombre, usuario_proceso)
    values (liq, 'liquidacion', 'contratista', 'contratista', 'Cuenta de liquidación: ' || p_motivo,
      jsonb_build_object('creada', true, 'valor_liquidacion', p_valor, 'fecha_liquidacion', p_fecha), nom, yo);
    creada := true;
  end if;

  update public.cc_contratos set liquidado = true, liq_fecha = p_fecha, liq_valor = p_valor, liq_motivo = p_motivo,
    liq_por = nom, liq_en = now(), actualizado_en = now()
   where id = p_contrato;

  perform set_config('cc.rpc', '', true);
  return jsonb_build_object('anuladas', anuladas, 'cuenta_liquidacion', liq, 'creada', creada);
end $$;

-- ── Revertir liquidación (solo superadmin) ──────────────────────────
create or replace function public.cc_revertir_liquidacion(p_contrato uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  nom text := public.cc_nombre_actual();
  k public.cc_contratos;
  c record;
  d jsonb;
  n int := 0;
begin
  if public.cc_proceso() is distinct from 'superadmin' then
    raise exception 'Solo el superadministrador puede revertir una liquidación';
  end if;
  select * into k from public.cc_contratos where id = p_contrato for update;
  if not found or not k.liquidado then raise exception 'El contrato no está liquidado'; end if;

  perform set_config('cc.rpc', '1', true);

  for c in select * from public.cc_cuentas where contrato_id = p_contrato and es_liquidacion loop
    if c.etapa <> 'contratista' or exists (select 1 from public.cc_movimientos m where m.cuenta_id = c.id and m.accion <> 'liquidacion') then
      raise exception 'La cuenta de liquidación (pago %) ya está en trámite; no se puede revertir', c.num_pago;
    end if;
    select detalle into d from public.cc_movimientos where cuenta_id = c.id and accion = 'liquidacion' order by creado_en desc limit 1;
    if coalesce((d->>'creada')::boolean, false) then
      delete from public.cc_cuentas where id = c.id;
    else
      delete from public.cc_movimientos where cuenta_id = c.id and accion = 'liquidacion';
      update public.cc_cuentas set es_liquidacion = false,
        valor = coalesce((d->>'valor_anterior')::numeric, valor),
        periodo_ini = (d->>'periodo_ini_anterior')::date, periodo_fin = (d->>'periodo_fin_anterior')::date,
        actualizado_en = now(), actualizado_por = nom
       where id = c.id;
    end if;
  end loop;

  -- las anuladas vuelven a quedar como pagos sin entregar
  for c in select * from public.cc_cuentas where contrato_id = p_contrato and etapa = 'anulada' loop
    delete from public.cc_movimientos where cuenta_id = c.id and accion = 'anular';
    update public.cc_cuentas set etapa = 'contratista', etapa_desde = now(), actualizado_en = now(), actualizado_por = nom where id = c.id;
    n := n + 1;
  end loop;

  update public.cc_contratos set liquidado = false, liq_fecha = null, liq_valor = null,
    notas = trim(coalesce(notas, '') || ' [Liquidación del ' || to_char(k.liq_fecha, 'DD/MM/YYYY') || ' por ' || coalesce(k.liq_valor::bigint::text, '0')
            || ' revertida por ' || nom || ' el ' || to_char(now() at time zone 'America/Bogota', 'DD/MM/YYYY') || '. Motivo original: ' || coalesce(k.liq_motivo, '') || ']'),
    liq_motivo = null, liq_por = null, liq_en = null, actualizado_en = now()
   where id = p_contrato;

  perform set_config('cc.rpc', '', true);
  return jsonb_build_object('restauradas', n);
end $$;

-- La consulta pública no muestra cuentas anuladas
create or replace function public.cc_consulta_publica(p_cedula text)
returns table (
  numero_contrato text, programa text, nombre text, num_pago int,
  periodo_ini date, periodo_fin date, valor numeric, etapa text, etapa_desde timestamptz,
  motivo_ult_dev text, tes_estado text, tes_fecha date, radicado text
)
language sql stable security definer set search_path = public as $$
  select k.numero_contrato, k.programa,
         regexp_replace(k.nombre, '(\S)\S*', '\1.', 'g'),
         c.num_pago, c.periodo_ini, c.periodo_fin, c.valor, c.etapa, c.etapa_desde,
         case when c.etapa = 'contratista' then c.motivo_ult_dev end,
         c.tes_estado, c.tes_fecha, c.radicado
  from public.cc_cuentas c join public.cc_contratos k on k.id = c.contrato_id
  where length(regexp_replace(coalesce(p_cedula,''), '\D', '', 'g')) >= 5
    and k.cedula = regexp_replace(p_cedula, '\D', '', 'g')
    and k.activo and c.etapa <> 'anulada'
  order by k.numero_contrato, c.num_pago;
$$;

-- ── Certificados de cumplimiento anulados ───────────────────────────
create table if not exists public.certeb_anulados (
  id              uuid primary key default gen_random_uuid(),
  radicado        text not null,
  codigo_contrato text,
  cedula          text,
  nombre          text,
  cuentas         text,
  total           numeric,
  motivo          text not null,
  anulado_por     text,
  anulado_en      timestamptz not null default now(),
  filas           jsonb not null default '[]'::jsonb
);
alter table public.certeb_anulados enable row level security;
drop policy if exists certeb_anulados_sel on public.certeb_anulados;
create policy certeb_anulados_sel on public.certeb_anulados for select using (public.es_superadmin() or public.cc_puede_ver());

create or replace function public.cc_borrar_certificado(p_radicado text, p_motivo text)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.es_superadmin() then raise exception 'Solo el superadministrador puede borrar certificados de cumplimiento'; end if;
  if nullif(trim(coalesce(p_motivo,'')),'') is null then raise exception 'El motivo es obligatorio'; end if;
  select count(*) into n from public.certeb_emitidos where radicado = p_radicado;
  if n = 0 then raise exception 'No existe el certificado %', p_radicado; end if;
  insert into public.certeb_anulados (radicado, codigo_contrato, cedula, nombre, cuentas, total, motivo, anulado_por, filas)
  select p_radicado, min(codigo_contrato), min(cedula), min(nombre),
         string_agg(coalesce('C' || cuenta_num::text, periodo_etiqueta, ''), ', ' order by cuenta_num),
         sum(total), p_motivo, public.cc_nombre_actual(), jsonb_agg(to_jsonb(e))
    from public.certeb_emitidos e where radicado = p_radicado;
  delete from public.certeb_emitidos where radicado = p_radicado;
  return n;
end $$;

revoke all on function public.cc_liquidar(uuid, date, numeric, text) from anon, public;
revoke all on function public.cc_revertir_liquidacion(uuid) from anon, public;
revoke all on function public.cc_borrar_certificado(text, text) from anon, public;
revoke all on function public.cc_nombre_actual() from anon, public;
grant execute on function public.cc_liquidar(uuid, date, numeric, text) to authenticated;
grant execute on function public.cc_revertir_liquidacion(uuid) to authenticated;
grant execute on function public.cc_borrar_certificado(text, text) to authenticated;
grant execute on function public.cc_nombre_actual() to authenticated;
