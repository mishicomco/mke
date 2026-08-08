# AI_ARTIFACTS — el tipo de app "artifact" de MKE

> v2 del diseño, 2026-08-01 (crítica de Claude sobre el diseño original del mismo día,
> aceptada por Santi). Estado de lo construido: `mke/AI_REPO_STATE.md`.

## El problema que resuelve

Construir `mishi-3d` (app estandar completa) costo caro. El peso NO estuvo en
stage->prod, que fueron dos comandos: estuvo en **repo ceremonioso + BD +
migraciones + CI**. Un artifact evita esas cuatro cosas para poder probar una
idea el mismo dia.

## La idea rectora (cambio central de la v2)

Un artifact NO es "un archivo sin repo": es **un repo de un solo archivo con
deploy de dos segundos**. Lo que mato a mishi-3d no fue git — fue el repo
CEREMONIOSO (CI, migraciones, BD, ambientes). Git cuesta cero y es el dueño de
la verdad de "qué existe" (jerarquía en `../CLAUDE.md`); eliminarlo era tirar
al bebé con el agua: sin git, el único ejemplar del fuente vivía en un PVC, y
perder el PVC perdía todas las ideas — exactamente lo que se quería evitar.

## Qué es un artifact

Un **frontend estandar de Mishi sin build y sin ambientes**: hereda el theme
neutro, la barra superior y (Fase 2) el login del IdP, pero es un solo archivo
HTML (o una carpeta chica con assets).

- URL: `<nombre>-artifact.mishi.com.co` — un solo lugar, sin stage ni prod.
- Vive hasta que lo borren; el fuente y su historia viven en el repo
  `artifacts-mishi` del forge (una carpeta por artifact, push-mirror a GitHub).

## Arquitectura

```
mke artifact publicar tienda tienda.html
   1. commit + push al repo artifacts-mishi (historia, rollback y backup gratis)
   2. CNAME tienda-artifact.mishi.com.co -> tunel mke-prod   (API CF, ~2 s)
   3. asegura routing (idempotente): IngressRoute regex + Middleware CSP
   4. kubectl cp -> PVC static-www:/srv/www/tienda-artifact/
      + symlink runtime -> ../artifact-runtime (runtime COMPARTIDO)
   5. doctor de la cadena publica
```

Hallazgos que lo hacen barato:

1. **nginx de static-mishi no se toca.** Su `server_name` regex ya mapea
   `tienda-artifact` -> `/srv/www/tienda-artifact` (una sola etiqueta DNS).
2. **El routing se resuelve una vez**, con UNA IngressRoute de Traefik
   (`HostRegexp(^[a-z0-9-]+-artifact\.mishi\.com\.co$)` -> static-mishi) + un
   Middleware CSP. Fase 2 agrega la segunda regla (`&& PathPrefix(/api)` ->
   artifact-mishi; gana por longitud). `mke artifact publicar` los aplica
   idempotente — no hay paso manual.
3. **Publicar es `kubectl cp`** al pod de static-mishi (monta el PVC RW).
   Segundos, no minutos.
4. **DNS: un CNAME por artifact.** DESCARTADO el comodin `*.mishi.com.co`
   (expondria la superficie entera del dominio).

## Runtime compartido: SERVIDO, no copiado

`mishi.css` / `mishi.js` viven UNA vez en el PVC (`/srv/www/artifact-runtime/v1/`)
y cada carpeta de artifact lleva un symlink `runtime -> ../artifact-runtime`,
asi el artifact lo referencia relativo a su propio origen:

```html
<link rel="stylesheet" href="/runtime/v1/mishi.css">
<script src="/runtime/v1/mishi.js"></script>
```

- La fuente de verdad del runtime es `mke/platform/artifacts/runtime/`;
  `publicar` la sincroniza al PVC en cada publicacion.
- **Pin por version MAYOR**: `v1` es contrato estable — un bug (incluso de
  seguridad) se parcha en UN lugar para TODOS los artifacts, sin republicar
  ninguno. `v2` solo cuando se rompa el contrato; los viejos siguen en `v1`.
- Contenido v1: theme neutro del molde + barra superior estandar +
  `window.mishi` (`sesion`, `cuandoSesion`, `datos.*` — Fase 2 VIVA en prod).

## Seguridad de origen desde el dia 1 (la leccion de la cookie)

`mishi_sesion` es cookie de dominio `.mishi.com.co`: el navegador la manda a
TODO subdominio. Un artifact es HTML arbitrario escrito rapido y sin revision
corriendo en un subdominio del ecosistema — sin defensa, un XSS en un artifact
es una cabeza de playa contra bank/omni/lo que confie en esa cookie.

Defensa (UNA regla de plataforma, no trabajo por artifact): el Middleware
`artifact-csp` inyecta en toda respuesta `*-artifact.*`:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; connect-src 'self'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'
```

Un artifact solo habla con su propio origen (su HTML, `/runtime`, `/_mishi`,
su futuro `/api`). `unsafe-inline` es inevitable (el artifact ES un HTML
inline); lo que importa es `connect-src/default-src 'self'`: sin exfiltracion
ni scripts de terceros. **Necesitar un CDN o una API externa es señal de
graduar.** Anotado y NO construido: claim `aud`/sesion degradada para origenes
artifact — solo si algun dia publica alguien que no sea Santi.

## Privados por defecto (artifact-guardia)

Un artifact es un prototipo del ecosistema, no una pagina publica: **TODO
`*-artifact.*` exige sesion del IdP** antes de servir un solo byte (el dato
embebido en el HTML tambien es dato). La puerta es `artifact-guardia`
(`platform/artifacts/guardia/`, ~90 lineas, unica dependencia jose), pieza de
plataforma de mke — identity-mishi NO se toco:

- Traefik **ForwardAuth** en la ruta de artifacts → `GET /guardia`: valida la
  cookie `mishi_sesion` (ES256, issuer `identity-mishi`) contra el JWKS de
  **ambos** emisores vivos (prod y stage — la cookie es de dominio compartido y
  la sesion de Santi puede venir de cualquiera); sin sesion → 302 al login
  ALOJADO del IdP (`/entrar?volver=https://<artifact>/...`; siempre https: el
  tunel habla http pero `volverPermitido` exige https).
- Ruta `/_mishi/*` SIN puerta (regla mas larga, gana): `GET /_mishi/sesion`
  (quien esta adentro, para la barra) y `POST /_mishi/salir` (borra la cookie
  de dominio — el host del artifact esta bajo `.mishi.com.co` y puede).
- `mishi.js` v1 pinta el chip de sesion (nombre/email + salir) en la barra y
  publica `mishi.sesion` + evento `mishi:sesion`.
- `guardiaDeploy()` es parte de `publicar` (se construye solo si falta);
  `mke artifact guardia` fuerza rebuild tras editar `server.mjs`.
### Quién entra: la tabla `accesos` (2026-08-08 — muere la allowlist en código)

La guardia autentica; QUIÉN puede ver cada artifact es dato, no código (dar
acceso no puede costar un redeploy). La verdad vive en la tabla `accesos` de
artifact-mishi: `(artifact, sujeto)` donde `artifact='*'` = todos y `sujeto` es
un email o `rol:<rol>` (rol por-app de `usuarios`). Un admin de artifact-mishi
entra a todo. Fail-closed: sin fila y sin admin, 403.

```
mke artifact acceso <n|--todos> <email|rol:x> [--quitar]
```

El verbo llama el endpoint solo-interno (`/api/interno/acceso`) con curl desde
el pod de static-mishi, igual que el registro del manifiesto. La guardia
consulta ese endpoint tras validar el JWT y cachea el veredicto **60 s por
email|artifact** (la ForwardAuth corre en cada request, incluidos assets).
`ALLOWED_EMAILS` sobrevive SOLO como respaldo anti-lockout: si artifact-mishi
no responde, la puerta cae a esa lista del env (no se cachea, para volver a la
verdad apenas reviva) en vez de dejar a todos afuera.

- Un artifact PUBLICO no existe hoy: si un prototipo necesita publico, es señal
  de graduar (o de un flag `--publico` futuro con caso real).

## Fase 1 — artifacts estaticos (construida; ver AI_REPO_STATE)

```
mke artifact nacer <nombre>                              cascaron modular estandar en ~/mishicomco/artifacts-mishi/<nombre>
mke artifact publicar <nombre> <archivo.html|carpeta> [--mensaje "..."]
                                                         idempotente; commit+push, CNAME, cp, aviso SSE, doctor
mke artifact ls                                          nombre, archivos, tamano, ultima publicacion (fecha de git)
mke artifact ver <nombre>                                URL + cadena publica
mke artifact rollback <nombre>                           vuelve a la version anterior (git) y republica
mke artifact borrar <nombre>                             PVC + CNAME (la historia queda en git)
```

### Cascaron modular (2026-08-07) — la forma canonica

Un artifact NO tiene que ser un solo archivo: `publicar` acepta carpetas y la
CSP permite `script-src 'self'`, asi que **ES modules nativos** (imports
relativos) y CSS aparte funcionan sin build. La forma canonica es la carpeta
modular que genera `mke artifact nacer` (la plantilla vive en
`platform/artifacts/plantilla/` y ES la documentacion del cascaron:
`index.html` + `estilos.css` + `src/*.js`). El single-file queda para lo
trivial. Escalón siguiente (anotado, no construido): `publicar` detecta
`vite.config.ts` y corre `vite build` local publicando `dist/` — recupera
TS/JSX/contract sin repo ni CI.

### Recarga en vivo (2026-08-07) — el ciclo de iteracion

No hay ambientes ni dev server (deliberado): se itera contra la URL real.
Para que eso sea rapido, **toda pestaña abierta se recarga sola al publicar**:

- `mishi.js` v1 abre `EventSource("/_mishi/eventos")` (SSE: cero polling, el
  navegador reconecta solo; pasa la CSP por ser mismo origen).
- La guardia mantiene el mapa host→pestañas en memoria (un pod, sin Redis) y
  manda keepalive cada 25 s (los proxies no cierran la conexion).
- `publicar`, tras el cp, hace POST `/avisar` a la guardia DESDE dentro del
  cluster; la guardia lo rechaza si viene por Traefik (`X-Forwarded-Host`
  presente = externo → 403): nadie puede recargar pestañas ajenas.

Ademas la republicacion es rapida: se salta el CNAME si el host ya resuelve y
el sync del runtime si su hash no cambio (`.hash` en el PVC); el doctor conoce
los artifacts (no busca Ingress — rutean por IngressRoute) y con CNAME recien
creado reintenta hasta 4 veces antes de declarar FAIL (propagacion ~10-30 s no
es un fallo).

### Cache (leccion 2026-08-07)

Cloudflare cacheaba `.js/.css` 4 h en el edge: iterar servia archivos VIEJOS.
El Middleware `artifact-csp` inyecta tambien `Cache-Control: no-cache` (CF lo
respeta → no cachea; el navegador revalida por etag, 304 baratos). Si un
artifact quedo envenenado de antes, referenciar el asset con `?v=x` bustea la
key del edge.

Reglas de nombre: `[a-z0-9-]`, sin sufijo `-artifact` ni `-stage` (colisiones
con la regex y con la convencion de subdominios); `mke app nacer` rechaza
nombres terminados en `-artifact` (sufijo reservado).

Con esto solo (sin backend) ya sirve para prototipos con `localStorage`.

## Fase 2 — `artifact-mishi`, el servicio de datos (CONSTRUIDA 2026-08-07; estado en el AI_REPO_STATE del repo artifact-mishi)

**Una app estandar del ecosistema**, nacida con `mke app nacer`: repo propio,
CI, migraciones normales. Lo especial: su BD es la capa de datos de TODOS los
artifacts. Cliente en el runtime:

```js
mishi.sesion                                   // quien esta adentro, o null
await mishi.datos.guardar('modelos', 'x', {…})
await mishi.datos.leer('modelos', 'x')
await mishi.datos.lista('modelos')
await mishi.datos.borrar('modelos', 'x')
```

### El contrato, pero como DATO

`packages/contract` funciona porque front y back se compilan juntos. Un
artifact rompe ese supuesto: no hay build y el backend compartido nunca vio ese
artifact. El contrato viaja como dato, en runtime:

```html
<script type="application/mishi-esquema">
{ "version": 1,
  "colecciones": {
    "modelos": {
      "visibilidad": "compartido",
      "campos": { "nombre": "texto!", "gramos": "numero",
                  "estado": ["candidato","impreso","muerto"] } } } }
</script>
```

`publicar` lo extrae y lo registra; el backend arma un Zod en runtime y valida
cada ESCRITURA con errores que nombran el campo. **La lectura NUNCA valida**:
devuelve lo que hay (un manifiesto v2 mas estricto no rompe datos v1 en
lectura; regla explicita para que nadie la "arregle" despues).

| App estandar | Artifact |
|---|---|
| `packages/contract`: Zod compilado | manifiesto: Zod en runtime |
| `schema.ts` + migracion | tabla `jsonb` + validacion en el borde |
| `lintMigraciones` (expand-contract) | `version` del manifiesto, mismas reglas |

Dos niveles: **Nivel 0 sin manifiesto** (`jsonb` libre, prototipo puro) y
**Nivel 1 con manifiesto** (validacion + documentacion viva). Lo que no se
recupera es el autocompletado del editor — costo real de no tener build, y una
señal mas de cuando graduar.

### Semilla de plataforma (2026-08-08)

Un artifact que abre VACÍO obliga a sembrar a mano desde una sesión, y esos
datos quedan con dueño real (editables/borrables). Por eso el manifiesto
declara datos iniciales:

```json
"colecciones": { "menu": { "campos": {…},
  "semilla": { "cafe": { "nombre": "Café", "precio": 4000 } } } }
```

Al registrar el manifiesto, artifact-mishi los materializa con el dueño
sintético `mishi:semilla` — ningún `sub` del IdP puede valer eso, así que la
regla "solo el dueño escribe" ya los vuelve intocables por API, sin regla
nueva. Es DECLARATIVO como kustomize: lo que el manifiesto deja de declarar se
BORRA (solo filas de ese dueño; los documentos de usuarios reales jamás entran
al diff, y un upsert nunca pisa una clave ocupada por alguien real). Se valida
contra los campos declarados (errores que nombran clave y campo) y cuenta
contra las cuotas: si no cabe, el registro entero falla (413) y no deja rastro.

### Modelo de datos

```sql
artifacts(nombre pk, dueno, creado_en, docs int, bytes bigint, ...)  -- registro + CONTADORES
datos(
  artifact text references artifacts,
  coleccion text, clave text,
  valor jsonb not null,
  dueno text,                    -- sub del IdP
  visibilidad text,              -- privado | compartido | publico
  creado_en, actualizado_en,
  UNIQUE(artifact, coleccion, clave),
  CHECK (pg_column_size(valor) <= 262144),
  CHECK (length(clave) <= 200)
)
```

El esquema es **de la plataforma**: un artifact nuevo no genera migraciones ni
DDL. Ahi muere el costo que dolio en mishi-3d.

### Autorizacion (decidida, simple, sin ACLs)

| visibilidad | leer | escribir/borrar |
|---|---|---|
| `privado` | dueño | dueño |
| `compartido` | cualquier sesion | **solo el dueño del documento** |
| `publico` | cualquiera | solo el dueño |

Escritura colaborativa sobre el MISMO documento no existe en artifacts — es
señal de graduar. Vandalismo imposible por construccion.

### Seguridad

- **Identidad**: cookie `mishi_sesion` contra el JWKS del IdP (mismo plugin
  Fastify). Escribir SIEMPRE exige sesion. CERO tokens en el HTML.
- **Aislamiento entre artifacts — LA frontera critica**: `artifact` se deduce
  SIEMPRE del `Host`, **jamas de un parametro del cliente**. Unico bug
  catastrofico e irreversible posible (fuga entre inquilinos). Se blinda con la
  FK y con tests que intenten escribir en otro artifact.
- **SIN trigger en la BD, sin `pg_jsonschema`**: hay UN solo escritor (este
  backend); duplicar la regla en Zod y JSON Schema desincroniza. En disco solo
  invariantes graves (unicidad, FK, tamano) con Postgres pelado. Se reconsidera
  el dia que haya un SEGUNDO escritor.

### Limites (con mecanica, no solo numeros)

256 KB/documento (CHECK) · 10.000 docs y 50 MB por artifact (contadores
`docs`/`bytes` en la fila de `artifacts`, actualizados en la MISMA transaccion
de cada escritura — un solo pod, sin carreras) · rate limit = token bucket
**por usuario×artifact** en memoria del backend (un pod; Redis = YAGNI).
Al pasarse: `413`/`429` con mensaje claro.

## Fase 3 — graduacion (NO construida; con el primer caso real)

`mke artifact graduar <nombre>` genera del manifiesto el `schema.ts` de drizzle,
la migracion `CREATE TABLE` y el volcado de los `jsonb` a columnas tipadas — **y
punto: el frontend se reescribe a mano** (esta escrito contra `mishi.datos.*`,
no contra una API tipada). Prometer menos hoy evita creerselo en seis meses.

## Lo que un artifact NO hace (deliberado)

Sin joins, sin consultas por campo arbitrario, sin transacciones entre
documentos, sin migraciones, sin ambientes, sin CDNs ni APIs externas.
**Necesitar cualquiera de esas cosas es la señal de graduar**, no un hueco que
haya que tapar.

## Riesgos vivos

1. **Base multi-inquilino** (Fase 2): un bug de aislamiento expone datos entre
   artifacts. Ahi va el esfuerzo de calidad.
2. **`jsonb` sin esquema envejece mal**: graduacion temprana es la cura.
3. **"Efimero" y "datos reales" en tension**: `ls` muestra docs + bytes +
   ultima escritura — la actividad reciente delata al que se volvio serio.
4. **Quien publica**: hoy, quien tenga la terminal del pc gamer (kubectl).
   Frontera implicita pero real; se formaliza si algun dia publica otro.

## Decisiones descartadas (y por que)

- **Comodin DNS `*.mishi.com.co`**: superficie entera del dominio expuesta.
- **Un Postgres nuevo para artifacts**: duplica backups y rompe "un dueño por
  tipo de dato"; lo que faltaba era un servicio sin esquema, no un motor.
- **`pg_jsonschema`**: no esta en `postgres:16-alpine`, exigiria imagen propia
  (pgrx/musl) acoplando cada restore a ese artefacto; y con un solo escritor el
  trigger duplica la regla.
- **URL por ruta (`artifact.mishi.com.co/<nombre>`)**: origen compartido, rompe
  rutas relativas y mezcla cookies entre prototipos.
- **Runtime copiado por-artifact** (diseño v1): congelaba `mishi.js` en cada
  carpeta — un bug de seguridad × N artifacts = N republicaciones de fuentes
  que quiza ya no estan a mano. Servido + versionado por mayor lo reemplaza.
- **Sin repo** (diseño v1): el fuente sin dueño en la jerarquia de verdad;
  perder el PVC = perder todo, y republicar destruia la version anterior sin
  vuelta atras. El repo `artifacts-mishi` lo resuelve a costo cero.
