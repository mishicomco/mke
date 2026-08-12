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

## Decisión CERRADA (2026-08-12, Santi): BD por inquilino + flota de procesos

**Una sola regla en todo el ecosistema: BD lógica propia por app Y por
artifact** (motor único postgres-mishi — el engine jamás se multiplica).
Aislamiento del engine (fuga entre inquilinos imposible por construcción) y
graduación de datos en CERO absoluto (la BD ya era suya). Y para que el techo
no sean ~200 inquilinos:

- **Tier artifact — `postgrest-mishi`, la FLOTA**: UN pod con un supervisor
  chico (~150-200 líneas, pieza nuestra) que orquesta el binario PostgREST SIN
  tocarlo: rutea por Host; proceso vivo → pasa; sin proceso → lo LANZA en <1s
  apuntando a la BD de ESE artifact; mata los que llevan ~10 min sin tráfico.
  Scale-to-zero a nivel de PROCESO, sin KEDA: la RAM/conexiones las pagan solo
  los artifacts activos A LA VEZ; miles de artifacts totales en un pod. Costo:
  1-2 días de plataforma + cold start ~1s en el primer request de un dormido
  (aceptable para prototipos). Idea anotada como posible open source:
  cerebro-santi/postgrest-flota-opensource.md (patrón privado en
  Supabase/DeepLake, nadie lo ha empaquetado abierto — validado 2026-08-12).
- **La flota es el hogar DEFAULT de TODOS los inquilinos — artifacts Y apps**
  (2026-08-12, Santi): la frontera no es artifact-vs-app sino tolera-cold-start
  vs siempre-caliente. La BD nunca duerme (postgres-mishi siempre vivo); lo
  que duerme es el traductor de ~40MB, <1s de despertar UNA vez tras el idle —
  nadie lo nota, y el nodo deja de pagar decenas de pods idle. Una app CRUD
  con pocos usuarios vive en la flota tranquilamente.
- **Instancia dedicada = PERILLA explícita por inquilino, no categoría**: mke
  lo saca de la flota a su Deployment propio cuando hay una razón (prod con
  clientes pagando, cero cold start, recursos garantizados sin vecinos
  ruidosos). Misma BD, mismo binario, una línea de ruteo, reversible.
  Graduar deja de implicar pod propio: el pod llega cuando el NEGOCIO lo pide,
  no el rito. (El `block-mishi-pgrst` dedicado del milestone 1 es esta perilla
  encendida; puede volver a la flota cuando exista.)
- Válvula si algo duele: PgBouncer el día que las conexiones de los ACTIVOS
  se queden cortas.
- Descartado: schema-por-artifact en BD compartida (frontera blanda — pagaba
  un problema de RAM hipotético comprando de vuelta el riesgo de fuga) y
  parchear PostgREST para multi-DB (fork Haskell eterno).
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
