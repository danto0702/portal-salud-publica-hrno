-- CertiVac — Seguridad de tablas (06/10/2026)
-- Antes: políticas "true" para anon y authenticated => cualquiera con la clave
-- pública (incluida en el HTML de GitHub Pages) podía leer, modificar y borrar todo,
-- incluidos los documentos de los pacientes.
-- Ahora: solo usuarios del portal con permiso en el módulo "certivac" (o superadmin).
--   Leer                       -> nivel lectura
--   Cargar archivos            -> nivel registro (insertar/actualizar registros y archivos,
--                                 borrar un archivo: el CASCADE borra sus registros)
--   Borrar registros sueltos   -> nivel admin ("Borrar todo")
--   Alias, asignaciones,
--   ciclos/valores y config    -> nivel admin

create or replace function public.certivac_puede(p_nivel text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.es_superadmin() or public.tiene_permiso('certivac', p_nivel);
$$;
revoke all on function public.certivac_puede(text) from public, anon;
grant execute on function public.certivac_puede(text) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['certivac_registros','certivac_archivos','certivac_ciclos',
    'certivac_alias_vacunadoras','certivac_asignaciones_municipio','certivac_config']
  loop
    execute format('drop policy if exists certivac_anon_all on public.%I', t);
    execute format('drop policy if exists certivac_auth_all on public.%I', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy certivac_leer on public.%I for select to authenticated using ((select public.certivac_puede(''lectura'')))', t);
  end loop;
end $$;

-- Registros y archivos: carga con nivel registro
create policy certivac_insertar on public.certivac_archivos for insert to authenticated
  with check ((select public.certivac_puede('registro')));
create policy certivac_actualizar on public.certivac_archivos for update to authenticated
  using ((select public.certivac_puede('registro'))) with check ((select public.certivac_puede('registro')));
create policy certivac_borrar on public.certivac_archivos for delete to authenticated
  using ((select public.certivac_puede('registro')));

create policy certivac_insertar on public.certivac_registros for insert to authenticated
  with check ((select public.certivac_puede('registro')));
-- "Normalizar nombres" actualiza registros: es una acción de administración
create policy certivac_actualizar on public.certivac_registros for update to authenticated
  using ((select public.certivac_puede('admin'))) with check ((select public.certivac_puede('admin')));
create policy certivac_borrar on public.certivac_registros for delete to authenticated
  using ((select public.certivac_puede('admin')));

-- Tablas de configuración: solo admin
do $$
declare t text;
begin
  foreach t in array array['certivac_ciclos','certivac_alias_vacunadoras',
    'certivac_asignaciones_municipio','certivac_config']
  loop
    execute format('create policy certivac_admin_insertar on public.%I for insert to authenticated with check ((select public.certivac_puede(''admin'')))', t);
    execute format('create policy certivac_admin_actualizar on public.%I for update to authenticated using ((select public.certivac_puede(''admin''))) with check ((select public.certivac_puede(''admin'')))', t);
    execute format('create policy certivac_admin_borrar on public.%I for delete to authenticated using ((select public.certivac_puede(''admin'')))', t);
  end loop;
end $$;

-- Índice para la FK (borrado en cascada y conteo por archivo)
create index if not exists certivac_registros_id_archivo_idx on public.certivac_registros (id_archivo);
