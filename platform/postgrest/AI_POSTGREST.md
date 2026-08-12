# platform/postgrest — el plano de datos del estándar nuevo (AI_GRADUACION.md)

> Milestone 1 VIVO en stage (2026-08-12), aplicado A MANO con block-mishi como
> primer caso. Destino: verbo `mke` que genere/aplique esto por app. Nada de
> esto toca prod ni el backend Fastify existente (el rol dueño bypassa RLS).

## Piezas (todas corriendo en ns `stage` del gamer)

- `postgrest-block.yaml` — Deployment+Service `block-mishi-pgrst`
  (postgrest/postgrest:v12.2.12) contra la BD `block_mishi` de databases-dev.
  JWT validado con el JWKS de AMBOS emisores (Secret `block-mishi-pgrst`,
  claves `PGRST_DB_URI` + `PGRST_JWT_SECRET`). Anon-role = rol web: la sesión
  la exige la puerta; RLS por `sub` decide qué filas.
- `puerta/` — **pgrst-puerta**, ForwardAuth cookie `mishi_sesion` → header
  `Authorization: Bearer` (hermana de artifact-guardia; 401 JSON, sin
  redirect: el cliente es fetch de SPA). Imagen en el registry local
  (`k3d-registry-mishi:5111/pgrst-puerta:v1`). UNA instancia sirve a todos los
  PostgREST futuros.
- `pgrst-puerta-k8s.yaml` — Deployment/Service de la puerta + Middlewares
  (forwardAuth con authResponseHeaders + stripPrefix `/datos`) + IngressRoute
  `Host(block-stage) && PathPrefix(/datos)` → PostgREST.
- `block-pgrst-roles.sql` — roles (`block_mishi_pgrst` authenticator LOGIN,
  `block_mishi_web` NOLOGIN), grants y políticas RLS. Correr como postgres.
  El CREATE ROLE es PROVISIÓN de plataforma (el rol de app no puede);
  RLS/vistas/función son esquema de la app → destino: migración en su repo.
- `block-pgrst-logica.sql` — `guardar_partida()` transaccional SECURITY
  DEFINER (única puerta de INSERT a partida) + vistas ranking /
  ranking_semanal / mis_stats. Correr con `SET ROLE block_mishi` (gotcha del
  dueño: como postgres, la DEFINER sería superusuario).

## Verificado E2E (2026-08-12)

- interno: sin JWT → `[]` (RLS corta); JWT firma falsa → 401 PGRST301.
- público `https://block-stage.mishi.com.co/datos/ranking`: sin cookie → 401
  de la puerta; cookie basura → 401; cookie REAL (navegador, sesión del IdP)
  → 200 `[]` (BD stage vacía: dato correcto). `/salud` de la app vieja intacto.
- `/rpc/guardar_partida` sin sesión → 403 `28000 "sin sesión"`.

## Deuda consciente

- Aplicación fue a mano: falta el verbo mke (generar por app: rol+secret+pod
  postgrest+ruta) y mover RLS/vistas a migración del repo de block.
- El JWKS en el Secret es una FOTO: si el IdP rota llaves hay que re-patchear
  (la puerta usa createRemoteJWKSet y se actualiza sola; PostgREST no).
- Front de block aún habla con el Fastify; el switch a `/datos` es la próxima
  tanda (con eso el Fastify de block queda para morir en stage).
