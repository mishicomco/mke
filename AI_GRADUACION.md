# AI_GRADUACION — la escalera artifact → app productiva

> Diseño, 2026-08-12 (conversación Santi + Claude). NADA construido aún.
> Estado de lo construido: `AI_REPO_STATE.md`. Primer caso real: **Guarda**
> (hoy `guarda-artifact`, quiere volverse productiva rápido y sin dolor).

## La tesis

La brecha entre un artifact y una app Mishi NO son los ambientes (un artifact
nace en prod). Son los cuatro impuestos del repo ceremonioso: **CI, overlays,
BD, migraciones** — y de esos, tras la convergencia de 2026-08, los dos
primeros ya cuestan ~cero (workflow delgado + pipeline en `mke deploy`;
overlays generados por el template). La brecha real quedó en **BD** y en
**lógica de servidor**.

La respuesta NO es artesanal (motor propio de DDL desde un manifiesto JSON —
descartado por reinventar Prisma). Es el modelo que la industria ya validó
(**Supabase**), self-hosteado en sus dos piezas estándar:

- **Postgres** (ya lo tenemos: postgres-mishi) — los datos del artifact viven
  desde el día 1 en Postgres real, con columnas reales.
- **PostgREST** — un binario maduro que expone cada tabla de un schema como
  API REST (filtros, orden, paginación, escritura), sin backend propio.
- **RLS (Row Level Security)** — la autorización `privado/compartido/publico`
  como políticas nativas de Postgres, no código nuestro. PostgREST valida el
  JWT (nuestro IdP ya firma ES256 + JWKS — PostgREST lo habla nativo) y asume
  el rol de la sesión.

**La tabla ES el contrato.** Un artifact con datos lleva un `esquema.sql` —
SQL plano, cero sintaxis inventada — que `publicar` aplica idempotente en SU
schema de postgres-mishi. Se acaba el manifiesto-JSON y el motor de Zod en
runtime para el caso tipado.

## El estándar mínimo (a lo que converge todo lo nuevo)

```
front estático + esquema.sql + PostgREST + RLS
```

Eso ya aguanta usuarios y datos REALES — no es juguete, es Postgres respaldado
por el mismo pg_dump→Drive de siempre. Cada escalón posterior se paga solo
cuando el producto lo pide:

| Escalón | Cuándo | Qué agrega |
|---|---|---|
| 0. Nace | idea de hoy | carpeta en `artifacts-mishi`, una URL (prod), `mishi.datos` jsonb libre (Nivel 0 actual, sigue existiendo como puerta de entrada) |
| 1. Datos serios | primera tabla real | `esquema.sql` en la carpeta → schema propio en postgres-mishi + PostgREST + RLS. Cero migración después: nació con columnas |
| 2. Se gradúa | usuarios productivos | `mke artifact graduar`: repo propio en el forge (historia FILTRADA de artifacts-mishi — `git filter-repo`/subtree split, se conserva todo) + workflow delgado + host stage. Su URL de siempre queda como prod; stage es lo nuevo. Cero cambios de código, cero movimiento de datos |
| 3. Lógica pegada a datos | reglas/transacciones | funciones SQL expuestas por PostgREST (`POST /rpc/<fn>`) — atómico por naturaleza |
| 4. Lógica que sale al mundo | integraciones (Dropi, omni, vault) | runtime de funciones estilo edge: un archivo TS = un endpoint, deployado por mke, secretos por lease, sesión ya validada. **Plataforma nueva — se construye cuando el PRIMER caso real lo pida, no antes** |
| 5. Backend completo (molde) | estado en memoria, websockets, workers, orquestación | el Fastify del molde actual, hablando con la MISMA base que ya tiene. Deja de ser "el estándar": es la excepción justificada (omni, chrome) |

La graduación deja de ser el salto brutal de la Fase 3 vieja ("el frontend se
reescribe a mano") porque ya no hay nada que reescribir: el contrato del front
son las tablas/API, y esas no cambian al subir de escalón.

## Reglas duras

1. **Las apps productivas actuales NO se reescriben.** La ola de convergencia
   al molde acaba de cerrar; PostgREST es el camino de lo NUEVO (artifacts y
   apps que nazcan CRUD). La ley de convergencia sigue: un estándar, pero el
   estándar mínimo baja de "molde Fastify" a "front + esquema.sql + RLS".
2. **postgres-mishi no se rebautiza ni migra.** Sigue siendo el dueño único de
   los datos (mismas BDs, backups, pg_dump). PostgREST es un servicio de
   plataforma NUEVO al lado (un pod que lee esas mismas BDs).
3. **Evolución del esquema**: aditiva (tabla/columna nueva) = re-aplicar el
   `esquema.sql` idempotente. Destructiva (rename, tipo, drop) = SQL a mano a
   propósito — no hay automatización honesta de expand-contract y no se finge.
4. **YAGNI escalonado**: primer entregable = PostgREST + RLS para artifacts
   (escalones 1-2, reemplaza el tramo más artesanal de artifact-mishi para
   casos tipados). El runtime de funciones (escalón 4) espera su primer caso.
5. Nivel 0 (jsonb libre vía `mishi.datos`) no muere: es la entrada a costo
   cero. Puede incluso re-implementarse como tabla jsonb en tu propio schema,
   mismo motor.

## Decisión CERRADA (2026-08-12, Santi): dos tiers de datos

**El tier artifact debe escalar a MILES, no a 200** — el costo por-instancia se
paga solo al graduarse, que es cuando hay negocio que lo justifica. Somos
nuestros propios inquilinos: el riesgo multi-tenant se acepta con ojos
abiertos (las fugas se ARREGLAN, no se toleran) a cambio de esa escala.

- **Tier artifact — `postgrest-mishi` (motor de datos centralizado)**: UNA BD
  `artifacts_mishi` en postgres-mishi + un SCHEMA de Postgres por artifact
  (el `esquema.sql` se aplica a SU schema) + UN pod PostgREST para todos
  (`PGRST_DB_SCHEMAS` lista; el schema se elige por header `Accept-Profile`,
  que la puerta INYECTA derivándolo del Host — sobrevive la ley de
  artifact-mishi: el inquilino JAMÁS viene de un parámetro del cliente).
  Artifact nuevo = mke agrega el schema y NOTIFY reload (sin restart). RLS por
  `sub` para lo privado; frontera entre artifacts = grants de schema + header
  de la puerta. Un solo pool (el muro de max_connections no existe).
- **Tier graduado — instancia propia**: BD propia + PostgREST propio
  (exactamente lo que el milestone 1 montó para block-mishi — una app ES el
  tier de arriba). Graduar datos = dump del schema a la BD propia, un
  movimiento conocido de pg_dump.
- Válvulas si algo duele: scale-to-zero de instancias graduadas dormidas;
  PgBouncer el día que un pool se quede corto.
- **PostgREST es plataforma, una instancia por BD**: la app/artifact no escribe
  ni un byte de PostgREST — mke provisiona pod+rol+ruta igual que hoy
  provisiona BD y Secret. La puerta (`pgrst-puerta`) sí es UNA compartida.
- **JWT del IdP → RLS**: verificado VIVO (milestone 1, `platform/postgrest/`):
  ES256+JWKS del IdP directo en PGRST_JWT_SECRET (foto de AMBOS emisores),
  `sub` a las políticas vía `request.jwt.claims`. Roles: la puerta consulta
  iam-mishi por sub×app (patrón guardia, cache 60s) y los inyecta como header
  que las políticas leen vía `request.headers` — el cliente no puede
  falsificarlo (la ForwardAuth lo sobreescribe siempre).

## Decisiones abiertas (para diseñar con el caso Guarda)
- **`mishi.datos` como wrapper**: mantener la API `mishi.datos.*` como fachada
  sobre PostgREST (retrocompat con artifacts existentes) o exponer el estilo
  PostgREST directo (las IAs lo conocen de memoria por Supabase). Puede ser
  ambas: el runtime v1 no se rompe.
- **Dónde corre PostgREST**: prod (laptop) primero — los artifacts viven en
  prod. Stage aparece con la primera graduación.

## Qué sigue (orden)

1. Diseño fino de PostgREST + RLS con Guarda como caso (este doc §decisiones).
2. `mke artifact graduar` (escalón 2): repo propio + stage + workflow delgado.
3. Guarda productiva sobre el estándar nuevo — la prueba de fuego del diseño.
