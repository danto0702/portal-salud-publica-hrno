# Esquema de datos — Supabase SI-APS HRNO

Proyecto `wttljozqyaxlzilomnef`. Todas las tablas llevan prefijo `dnt_` y tienen
Row Level Security activo.

## Tablas

| Tabla | Qué guarda |
|---|---|
| `dnt_municipios` | Ábrego, Convención, El Carmen y Teorama, con código DANE y coordenadas |
| `dnt_sedes` | Puntos de atención, incluidos los corregimientos San Pablo y Guamalito |
| `dnt_perfiles` | Rol en el módulo (admin, coordinador, responsable) y estado de aprobación |
| `dnt_usuarios_municipio` | Alcance territorial de cada responsable |
| `dnt_ninos` | Datos del niño. Único por (tipo de documento, número) |
| `dnt_casos` | Un caso por episodio. Un solo caso abierto por niño a la vez |
| `dnt_seguimientos` | Cada atención: antropometría, puntajes Z, apetito, conducta, FTLC |
| ↳ perímetros | Braquial, cefálico (con `z_pc` y `clasificacion_pc`) y abdominal (valor crudo) |
| `dnt_factores_catalogo` · `dnt_caso_factores` | Catálogo de 16 factores y los presentes en cada caso |
| `dnt_checklist_catalogo` · `dnt_checklist_respuestas` | 24 ítems (A, B y C) y su estado por caso o por seguimiento |
| `dnt_soportes` | Archivos con versionado y borrado lógico recuperable |
| `dnt_jornadas_extramurales` | Búsqueda activa comunitaria |
| `dnt_inventario` | Movimientos de FTLC, fórmula de inicio, F-75, F-100, SRO |
| `dnt_equipos` | Hoja de vida y calibración de equipos antropométricos |
| `dnt_capacitaciones` | Talento humano capacitado, para el indicador trimestral |
| `dnt_importaciones` | Historial de cargues de Excel con sus alertas |
| `dnt_solicitudes_clave` | «Olvidé mi contraseña»: una pendiente por persona, la cierra el administrador |
| `dnt_log` | Auditoría: ingresos, consultas, cargues, descargas, cierres, permisos |

## Vistas

- **`dnt_v_casos_detalle`** — caso con su último seguimiento y el estado del control
  (al día, por vencer, vencido, sin programar, cerrado). Arrastra del último seguimiento el
  Z P/T-L, el edema y los tres perímetros: braquial, cefálico (con su Z y su clasificación)
  y abdominal.

  > El perímetro cefálico se compara con el patrón OMS 2006 (`hcfa`, 0 a 60 meses) y se
  > clasifica con los cortes de la Res. 2465 de 2016. El abdominal no tiene patrón de
  > referencia para menores de 5 años: se guarda el valor y se lee por la tendencia.
- **`dnt_v_indicadores`** — numeradores y denominadores de los indicadores mensuales.

Ambas con `security_invoker = true`: respetan la RLS del usuario que consulta.

## Seguridad

Unas funciones `SECURITY DEFINER` deciden todo:

| Función | Devuelve | Quién puede llamarla |
|---|---|---|
| `dnt_rol()` | admin, coordinador, responsable o ninguno. El superadministrador del portal cuenta como admin | authenticated |
| `dnt_municipios_usuario()` | Municipios visibles. Admin y coordinador ven todos | authenticated |
| `dnt_puede_ver(municipio)` | Lectura | authenticated |
| `dnt_puede_editar(municipio)` | Escritura. El coordinador siempre da falso: es de sólo lectura | authenticated |
| `dnt_rol_de(usuario)` | Lo mismo que `dnt_rol()` pero de cualquiera. `dnt_rol()` no es más que esta con `auth.uid()` | sólo `service_role` |
| `dnt_auth_id_por_correo(correo)` | El id de `auth.users`, para crear o vincular sin adivinar | sólo `service_role` |

Las dos últimas están cerradas a `anon` y `authenticated` a propósito: el rol ajeno no es
asunto del cliente, y una función que traduce correo a id sería un enumerador de cuentas.
Las usa la función de borde `dnt-usuarios`, que corre con la llave de servicio.

Tres triggers cierran los huecos que las políticas no cubren:

- **`dnt_hereda_municipio`** — el municipio de seguimientos, check-lists y soportes se
  deriva del caso. Un responsable no puede escribir en otro territorio falseando la columna.
- **`dnt_guard_casos`** — sólo coordinador y administrador cierran o reabren casos; el
  coordinador no puede tocar nada más.
- **`dnt_guard_perfiles`** — el autoregistro siempre nace *pendiente* y como *responsable*;
  nadie se asciende a sí mismo. Los cuatro guardianes dejan pasar sin restricción cuando
  `auth.uid()` es nulo, que es el caso de las migraciones y de la llave de servicio.

## Función de borde `dnt-usuarios`

El alta de cuentas no puede hacerse desde el navegador. `signUp` no devuelve sesión cuando
el proyecto exige confirmar el correo —así que el insert en `dnt_perfiles` salía como
`anon` y lo frenaba RLS— y, si el correo ya tenía cuenta, GoTrue devuelve un usuario
ofuscado con un uuid inventado que reventaba contra `dnt_perfiles_id_fkey`.

La función corre con la llave de servicio, resuelve primero la cuenta y después el perfil.
El código vive en `funciones/dnt-usuarios/`.

| Acción | Quién | Qué hace |
|---|---|---|
| `solicitar` | cualquiera, sin sesión | Crea o vincula la cuenta y deja el perfil *pendiente*. Tope de 60 solicitudes sin revisar |
| `olvide` | cualquiera, sin sesión | Deja una solicitud de contraseña en la bandeja del administrador. Responde siempre igual, exista o no la cuenta. Tope de 40 sin atender |
| `crear` | admin | Alta completa: cuenta, perfil *activo*, rol y municipios. Devuelve la contraseña provisional |
| `clave` | admin | Contraseña provisional nueva. Marca `clave_provisional` y cierra la solicitud |
| `estado` | admin | Rol, estado y municipios en una sola operación. Al activar, confirma el correo |

`verify_jwt` va en `false` porque `solicitar` y `olvide` deben funcionar sin sesión; la
autorización se hace adentro, contra `dnt_rol_de()`.

## Restablecimiento de contraseñas

No pasa por el correo de Supabase. El enlace llegaba a buzones institucionales que nadie
revisa y caducaba antes de que lo abrieran, y el proyecto además exige confirmar el correo:
eran dos dependencias de un buzón que no se consulta.

1. La persona lo pide desde el ingreso. Queda una fila en `dnt_solicitudes_clave`.
2. El administrador la ve en **Administración → Usuarios** y genera la provisional.
3. `dnt_perfiles.clave_provisional` queda en `true`, y la solicitud en *atendida*.
4. Al entrar, el módulo la manda a elegir contraseña propia y no la deja pasar antes.
   Al guardarla, `clave_provisional` vuelve a `false` y se sella `clave_cambiada_en`.

El paso 4 se aplica en los dos caminos: al ingresar desde `login.html` y al abrir la
aplicación con una sesión ya abierta, porque `DNTAuth.verificar()` también devuelve al
cambio. Un índice único parcial impide que una persona llene la bandeja con solicitudes
repetidas.

### Cambios hechos fuera del módulo

Quien entre a la consola de Supabase puede cambiarle la contraseña a cualquiera sin pasar
por aquí. Eso no se puede impedir desde el código —es la consola del proveedor— pero el
trigger `dnt_audita_clave` sobre `auth.users` hace que no sirva en silencio:

- Deja un evento `clave_modificada` en `dnt_log`, con el correo afectado.
- Pone `clave_provisional` en `true`, así que al entrar el módulo exige elegir otra y la
  persona se entera de que alguien le tocó la cuenta.

Los cambios hechos desde el módulo también pasan por el trigger, pero acto seguido el
propio flujo levanta la marca (`cambiarClave`) o la confirma (acción `clave`). **Un
`clave_modificada` sin su evento del módulo al lado se hizo por fuera.** La auditoría
los pinta en naranja y lo explica sobre la tabla.

La función captura cualquier excepción y deja pasar: una falla de la auditoría nunca puede
tumbar el ingreso.

## Almacenamiento

Bucket privado `dnt-soportes`, máximo 15 MB por archivo, sólo PDF, JPEG, PNG y WEBP.
Ruta: `<MUNICIPIO_SLUG>/<caso_id>/<uuid>.<ext>`. Las políticas leen el municipio de la
primera carpeta de la ruta, así que el alcance territorial también aplica a los archivos.
Se sirven por URL firmada temporal, nunca en público.
