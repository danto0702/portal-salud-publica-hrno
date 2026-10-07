-- CertiVac — Verificación de trazadores PAI (07/10/2026)
-- Trazadores: BCG (recién nacidos), Pentavalente 3ª (menores de 1 año),
-- Triple Viral 1ª (niños de 1 año) y DPT 2º refuerzo (niños de 5 años).
-- Las dosis se cuentan desde certivac_registros (registros diarios) por cohorte PAI;
-- el BCG admite cifra manual por mes que REEMPLAZA la de los registros.
-- Municipio = el del archivo cargado (certivac_registros.municipio).

create table if not exists public.certivac_traz_poblacion (
  id uuid primary key default gen_random_uuid(),
  año smallint not null,
  municipio text not null,
  trazador text not null check (trazador in ('BCG','PENTA3','TV1','DPT2')),
  poblacion integer not null check (poblacion >= 0),
  fuente text,
  actualizado timestamptz not null default now(),
  unique (año, municipio, trazador)
);

create table if not exists public.certivac_traz_manual (
  id uuid primary key default gen_random_uuid(),
  año smallint not null,
  mes smallint not null check (mes between 1 and 12),
  municipio text not null,
  trazador text not null check (trazador in ('BCG','PENTA3','TV1','DPT2')),
  dosis integer not null check (dosis >= 0),
  usuario uuid default auth.uid(),
  actualizado timestamptz not null default now(),
  unique (año, mes, municipio, trazador)
);

alter table public.certivac_traz_poblacion enable row level security;
alter table public.certivac_traz_manual enable row level security;
revoke all on public.certivac_traz_poblacion, public.certivac_traz_manual from anon;

create policy certivac_leer on public.certivac_traz_poblacion for select to authenticated
  using ((select public.certivac_puede('lectura')));
create policy certivac_admin_insertar on public.certivac_traz_poblacion for insert to authenticated
  with check ((select public.certivac_puede('admin')));
create policy certivac_admin_actualizar on public.certivac_traz_poblacion for update to authenticated
  using ((select public.certivac_puede('admin'))) with check ((select public.certivac_puede('admin')));
create policy certivac_admin_borrar on public.certivac_traz_poblacion for delete to authenticated
  using ((select public.certivac_puede('admin')));

create policy certivac_leer on public.certivac_traz_manual for select to authenticated
  using ((select public.certivac_puede('lectura')));
create policy certivac_insertar on public.certivac_traz_manual for insert to authenticated
  with check ((select public.certivac_puede('registro')));
create policy certivac_actualizar on public.certivac_traz_manual for update to authenticated
  using ((select public.certivac_puede('registro'))) with check ((select public.certivac_puede('registro')));
create policy certivac_borrar on public.certivac_traz_manual for delete to authenticated
  using ((select public.certivac_puede('registro')));

-- Dosis de trazadores por municipio y mes, contadas por cohorte PAI.
-- security invoker: aplica la RLS de certivac_registros (nivel lectura).
create or replace function public.certivac_trazadores_mes(p_año int)
returns table (municipio text, mes smallint, trazador text, dosis bigint)
language sql stable security invoker set search_path = public
as $$
  select r.municipio, r.mes_num, t.trazador, count(*)
  from public.certivac_registros r
  cross join lateral (select case
    when r.biologico ilike 'BCG%'
         and (r.poblacion = 'Recién Nacidos' or r.edad_meses < 12) then 'BCG'
    when r.biologico ilike 'PENTA%' and r.texto_dosis ~* '^\s*(tercera|3ra|3a)\M'
         and r.edad_meses < 12 then 'PENTA3'
    when r.biologico ilike 'TRIPLE VIRAL%' and r.texto_dosis ~* '^\s*(primera|1ra|1a)\s*dosis'
         and r.edad_meses between 12 and 23 then 'TV1'
    when r.biologico ~* '^\s*DPT' and r.texto_dosis ~* '^\s*(segundo|2do|2°)\s*refuerzo'
         and r.edad_meses between 60 and 71 then 'DPT2'
  end as trazador) t
  where r.año = p_año and t.trazador is not null and coalesce(r.municipio, '') <> ''
  group by 1, 2, 3;
$$;

-- Archivos cargados por municipio y mes (para advertir meses sin registros).
create or replace function public.certivac_archivos_mes(p_año int)
returns table (municipio text, mes smallint, archivos bigint, registros bigint)
language sql stable security invoker set search_path = public
as $$
  select r.municipio, r.mes_num, count(distinct r.id_archivo), count(*)
  from public.certivac_registros r
  where r.año = p_año and coalesce(r.municipio, '') <> ''
  group by 1, 2;
$$;

revoke all on function public.certivac_trazadores_mes(int), public.certivac_archivos_mes(int) from public, anon;
grant execute on function public.certivac_trazadores_mes(int), public.certivac_archivos_mes(int) to authenticated;

create index if not exists certivac_registros_año_mes_idx on public.certivac_registros (año, mes_num);

-- Población meta programática 2026 (20251228) Ver0 — hoja "Hoja1 (2)" de
-- METAS TRAZADORES 2026 AGOSTO.xlsb
insert into public.certivac_traz_poblacion (año, municipio, trazador, poblacion, fuente) values
  (2026,'ABREGO','BCG',326,'Meta programática 2026 (20251228) Ver0'),
  (2026,'ABREGO','PENTA3',399,'Meta programática 2026 (20251228) Ver0'),
  (2026,'ABREGO','TV1',403,'Meta programática 2026 (20251228) Ver0'),
  (2026,'ABREGO','DPT2',506,'Meta programática 2026 (20251228) Ver0'),
  (2026,'CONVENCION','BCG',229,'Meta programática 2026 (20251228) Ver0'),
  (2026,'CONVENCION','PENTA3',246,'Meta programática 2026 (20251228) Ver0'),
  (2026,'CONVENCION','TV1',251,'Meta programática 2026 (20251228) Ver0'),
  (2026,'CONVENCION','DPT2',322,'Meta programática 2026 (20251228) Ver0'),
  (2026,'EL CARMEN','BCG',132,'Meta programática 2026 (20251228) Ver0'),
  (2026,'EL CARMEN','PENTA3',162,'Meta programática 2026 (20251228) Ver0'),
  (2026,'EL CARMEN','TV1',184,'Meta programática 2026 (20251228) Ver0'),
  (2026,'EL CARMEN','DPT2',215,'Meta programática 2026 (20251228) Ver0'),
  (2026,'TEORAMA','BCG',226,'Meta programática 2026 (20251228) Ver0'),
  (2026,'TEORAMA','PENTA3',299,'Meta programática 2026 (20251228) Ver0'),
  (2026,'TEORAMA','TV1',310,'Meta programática 2026 (20251228) Ver0'),
  (2026,'TEORAMA','DPT2',345,'Meta programática 2026 (20251228) Ver0')
on conflict (año, municipio, trazador) do nothing;
