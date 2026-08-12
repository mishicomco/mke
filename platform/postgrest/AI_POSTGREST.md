# platform/postgrest — el plano de datos del estándar nuevo (AI_GRADUACION.md)

> ACTUALIZACIÓN 2026-08-12 (misma noche): nació **`flota/` (postgrest-flota)**
> y ES el hogar default de todos los inquilinos. El Deployment dedicado
> `block-mishi-pgrst` se BORRÓ (primer pod ahorrado): `/datos` de block-stage
> rutea a la flota, que lanza el proceso del inquilino al vuelo (315ms medido)
> y mata los idle (10 min). Config de inquilinos = Secret
> `postgrest-flota-config` (inquilinos.json + jwks.json), lo escribe mke.
> Lo de abajo documenta el milestone 1 (instancia dedicada) — sigue siendo
> válido como el tier "perilla dedicada" y como referencia del SQL/RLS.

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

## Autorización iam-mishi (flota v2, 2026-08-12)

Ley del ecosistema: permisos, nunca roles. Inquilino que declara
`iam: { app, token, permisos: [...] }` en `inquilinos.json` → la flota consulta
`POST /v1/check` de iam-mishi con el token DE ESE inquilino (token-por-app, sin
súper-token; cache 60s por email|app; fail-closed a cero permisos) e inyecta
`X-Mishi-Permisos` al request (el del cliente se pisa SIEMPRE). En SQL, una
política lo lee así:

```sql
-- helper por app (dueño = rol de la app):
CREATE FUNCTION tiene_permiso(p text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p = ANY(string_to_array(
    coalesce(current_setting('request.headers', true)::json->>'x-mishi-permisos',''), ','))
$$;
-- CREATE POLICY moderar ON cosa FOR DELETE USING (tiene_permiso('app.cosa.moderar'));
```

Block no lo usa (todo es RLS por sub); el primer caso real será Guarda.

## Deuda consciente

- Aplicación fue a mano: falta el verbo mke (generar por app: rol+secret+pod
  postgrest+ruta) y mover RLS/vistas a migración del repo de block.
- El JWKS en el Secret es una FOTO: si el IdP rota llaves hay que re-patchear
  (la puerta usa createRemoteJWKSet y se actualiza sola; PostgREST no).
- Front de block aún habla con el Fastify; el switch a `/datos` es la próxima
  tanda (con eso el Fastify de block queda para morir en stage).
