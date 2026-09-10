# Sincronización de agencias Shalom → Back4App

`check_agencias.js` mantiene al día la clase **`SucursalShalom`** de Back4App
con el listado público de agencias de `shalom.com.pe/agencias/agencias`.

- Corre 1 vez al día (`.github/workflows/check_agencias.yml`) + manual.
- Usa los mismos secrets que `check_shalom.js`: `BACK4APP_APP_ID`,
  `BACK4APP_MASTER_KEY`.
- Nunca borra: las agencias que desaparecen del scrape se marcan
  `activa:false`.
- Si el scrape devuelve 0 agencias, aborta sin tocar nada.

## Clase `SucursalShalom` (se autocrea al primer POST)

| Campo           | Tipo    | Notas |
|-----------------|---------|-------|
| `terId`         | Number  | ID interno de Shalom (`ter_id`). Clave de match primaria. |
| `clave`         | String  | sha1(nombre+dirección normalizados). Match secundario. |
| `nombre`        | String  | |
| `direccion`     | String  | Incluye la referencia ("REF. ...") |
| `ciudad`        | String  | Distrito, en Title Case |
| `distrito`      | String  | = `ciudad` |
| `provincia`     | String  | Title Case |
| `departamento`  | String  | Title Case |
| `telefono`      | String? | Tal cual lo publica Shalom (suele ser el call center) |
| `horario`       | String? | Líneas de horario unidas con " · " |
| `categoria`     | String? | Categoría cruda de Shalom ("GRANDE / CO", ...) |
| `tipo`          | String  | Categoría mapeada al set del cotizador ("Grande / Co", "Micro", ...) |
| `lat`, `lng`    | Number? | |
| `activa`        | Boolean | `false` = baja suave (ya no aparece en Shalom) |
| `fuente`        | String  | `"shalom-agencias-scraper"` |
| `sincronizadoEn`| String  | ISO de la última corrida que la tocó |
| `bajaEn`        | String? | ISO en que se marcó inactiva |

## Class Level Permissions (dashboard de Back4App)

Clase `SucursalShalom` → **Security / CLP**:

| Permiso            | Público | Motivo |
|--------------------|:------:|--------|
| **Get**            | ✅ Sí  | El cotizador (SIA) lee agencias sueltas |
| **Find**           | ✅ Sí  | El cotizador lista `where {activa:true}` |
| **Count**          | ✅ Sí (opcional) | |
| **Create**         | ❌ No  | Solo el bot (Master Key ignora CLP) |
| **Update**         | ❌ No  | Solo el bot |
| **Delete**         | ❌ No  | El bot tampoco borra: hace baja suave |
| **Add field**      | ❌ No  | Cambios de esquema solo por Master Key / dashboard |

- Datos públicos (es el directorio de agencias de Shalom), así que Get/Find
  en **Public** es lo más simple. Si se prefiere, "Requires authentication"
  también funciona: el frontend siempre llama con session token.
- No hace falta ningún Role: el bot escribe con **Master Key**, que
  siempre pasa por encima de las CLP.
