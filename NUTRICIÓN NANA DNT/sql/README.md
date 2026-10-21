# Migraciones aplicadas en Supabase — proyecto SI-APS HRNO

Todas las migraciones ya fueron aplicadas al proyecto `wttljozqyaxlzilomnef` (SI-APS HRNO).

> La 18 va partida en cinco porque el servicio corta las migraciones largas por
> tiempo de espera. Son un solo cambio: el restablecimiento de contraseñas.
Este directorio conserva el histórico para control de cambios y para poder reconstruir
el esquema en otro proyecto.

| # | Migración | Contenido |
|---|-----------|-----------|
| 01 | `dnt_01_catalogos_perfiles_helpers` | Municipios, sedes, perfiles, alcance territorial y funciones de permisos |
| 02 | `dnt_02_ninos_casos_seguimientos` | Niños, casos, seguimientos y factores de riesgo |
| 03 | `dnt_03_checklist_soportes_apoyo` | Check-lists, soportes versionados, extramural, inventario, equipos, importaciones y auditoría |
| 04 | `dnt_04_semillas_catalogos` | Semillas de municipios, sedes, 16 factores de riesgo y 24 ítems de check-list |
| 05 | `dnt_05_triggers_integridad` | Herencia de municipio, blindaje de cierre de casos, versionado de soportes |
| 06 | `dnt_06_rls_politicas` | Row Level Security de todas las tablas |
| 07 | `dnt_07_storage_bucket` | Bucket privado `dnt-soportes` con políticas por municipio |
| 08 | `dnt_08_capacitaciones_vistas_indicadores` | Capacitaciones y vistas `dnt_v_casos_detalle` y `dnt_v_indicadores` |
| 09 | `dnt_09_registro_modulo_y_admin` | Registro en `portal_modulos` y perfil del superadministrador |
| 10 | `dnt_10_hardening_funciones` | `search_path` fijo y permisos mínimos de ejecución |
| 11 | `dnt_11_fix_guard_perfiles_contexto_servicio` | Los triggers ceden ante el contexto de servicio |

Para exportar el esquema vigente:

```sql
-- Desde el SQL editor de Supabase
select table_name, column_name, data_type
from information_schema.columns
where table_schema='public' and table_name like 'dnt%'
order by table_name, ordinal_position;
```

| 12 | `dnt_12_carga_historica_temporal` | Función temporal de carga (reemplazada por la 13) |
| 13 | `dnt_13_carga_historica_v2` | Mesa de trabajo y expansor de la carga compactada |
| 14 | `dnt_14_retirar_carga_historica` | Retiro del andamiaje y registro del cargue |
| 15 | `dnt_15_gestion_usuarios` | `dnt_rol_de()` y `dnt_auth_id_por_correo()`, apoyo de la función de borde |
| 16 | `dnt_16_perimetros_cefalico_abdominal` | Perímetro abdominal, y puntaje Z y clasificación del cefálico |
| 17 | `dnt_17_vista_casos_con_perimetros` | `dnt_v_casos_detalle` arrastra los dos perímetros de la última medición |
| 18a | `dnt_18a_clave_provisional` | `clave_provisional` y `clave_cambiada_en` en los perfiles |
| 18b | `dnt_18b_solicitudes_clave` | Tabla `dnt_solicitudes_clave` con una sola pendiente por persona |
| 18c–e | `dnt_18c_sol_clave_select` · `_update` · `_delete` | RLS: sólo el administrador las ve y las cierra |
| 19 | `dnt_19_auditar_cambio_de_clave` · `_19b` | Todo cambio de contraseña queda en `dnt_log` y marca la cuenta como provisional |

## Carga histórica

Los cinco informes institucionales de enero a agosto de 2026 quedaron cargados el
16 de septiembre de 2026, con los puntajes Z recalculados con las tablas OMS 2006:

| Archivo | Municipio | Atenciones | Niños |
|---|---|---|---|
| Informe_de_Desnutricion_PrimeraInfancia_Abrego | Ábrego | 111 | 102 |
| Informe_..._Convencion_Enero_Agosto_2026 | Convención | 54 | 52 |
| Informe_..._el_Carmen | El Carmen | 22 | 17 |
| Informe_..._Guamalito_Enero_Agosto_2026 | El Carmen | 23 | 21 |
| Informe_..._San_Pablo_Enero_Agosto_2026 | Teorama | 61 | 50 |
| **Total** | | **271** | **242** |

Clasificación resultante: 208 casos en riesgo, 27 con desnutrición aguda moderada y
7 con desnutrición aguda severa. Ninguna fila se descartó.
