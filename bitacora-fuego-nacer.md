# Bitácora — prueba de fuego: nacer apps al estándar

Objeto: `mke app nacer` + create-mishi-app + componentes alrededor (init de plataforma, CI del forge, deploy a stage, identidad, DNS/static-mishi).
Ley: toda fricción se anota y se arregla DE RAÍZ en el mismo turno; nunca se esquiva.

| # | Ronda | Fricción | Estado | Arreglo |
|---|-------|----------|--------|---------|
| F1 | R1 | `mke app nacer` muere en `npm install` con E401 (nadie exporta NODE_AUTH_TOKEN; secreto adivinado) | resuelta | mke lee `git-mishi-npm-token` del vault y lo inyecta por env del hijo (appNacer.ts, rama fuego-nacer) |
| F2 | R1 | reanudar con `--sin-cascaron` salta git+push → repo sin remotos; re-correr a secas revienta | resuelta | cascarón idempotente (dir existente = reanudación) + git+push desacoplado del flag (appNacer.ts) |
| F3 | R1 | `drizzle-kit generate` interactivo muere sin TTY cuando el diff parece renombrada | resuelta | documentado en skill molde-apps (dos migraciones o dejar `ejemplo` hasta después) |
| F4 | R1 | **API de app recién nacida ABIERTA a internet** (coordinador: POST anónimo → 201; viola idp-permisivo-toda-puerta-autoriza) | resuelta | template apiRoutes fail-closed: scope /api exige sesión, excepción única /health (create-mishi-app rama fuego-nacer); fogata parchada y re-verificada 401 en stage |

| F5 | R2 | `vault escribir` 403 en TODO primer nacimiento: grants aplicados al vault congelado de stage (gamer) mientras la escritura va al vault vivo (prod, laptop); y el init imprimía "guardado" pese al fallo | resuelta | grants ANTES de escribir y contra `VAULT.podContext/podNamespace` (mke-prod-laptop/prod); `guardarSecretoDb` devuelve `{guardado,rotado}` y el init reporta WARN honesto; backfill fogata+brasero verificado (secreto: creado) |
| F6 | R2 | paso "registro en Studio" muerto suelta WARN en cada nacimiento (Studio archivado 2026-08-07) | resuelta | paso eliminado de appNacer (catálogo = ConfigMap mke-catalogo que ya regenera app init); --sin-registro queda no-op |
| F7 | R3 (adversario) | CORS refleja CUALQUIER Origin con `credentials:true` (antipatrón; hoy mitigado por SameSite=Lax pero frágil) | resuelta | template + brasero: allowlist real `*.mishi.com.co` + localhost, nunca eco de Origin; verificado en vivo (evil→sin ACAO, mishi→204 con ACAO) |

## Rondas
- R2 (2026-08-08): a ciegas — `brasero` (gastos del hogar) VIVA en stage; `mke app nacer` E2E sin fricción (valida F1/F2); API nació fail-closed 401 (valida F4); drizzle sin choque (F3 documentada sirvió). 2 fricciones nuevas (F5, F6) → resueltas.
- R1 (2026-08-08): a ciegas — nacer `fogata` (lista de mercado) → VIVA en stage, CI verde. 3 fricciones de onboarding + 1 hallazgo grave del coordinador (F4). Sondeo adversario liviano: /dev y /api/auth fail-closed en stage → AGUANTÓ. Datos de prueba limpiados.
- R3 (2026-08-08): a ciegas — `hoguera` (tablero del edificio) VIVA en stage. **CERO fricciones de raíz** (solo la compuerta esperada de espejo de migraciones). Adversario contra brasero: todo lo crítico AGUANTÓ (gate de sesión, JWKS real, sin fuga en errores/bundle, sin path traversal), único hallazgo F7 (CORS) → resuelto y re-verificado.

Curva de fricción: R1 = 4 → R2 = 2 → R3 = 0 de onboarding (+1 adversario, cerrado). **Señal de LISTO alcanzada**: ronda a ciegas limpia + adversario donde todo lo crítico aguantó. Nacimiento endurecido.

Apps de prueba: fogata, brasero, hoguera — BORRADAS 2026-08-08 con el verbo nuevo `mke app borrar` (k8s+BD/rol+DNS+static+forge+dir+catálogo), hosts en 530 y dirs eliminados.

| F8 | cierre (borrado) | asimetría: `mke app nacer`/`init` existían pero NO `mke app borrar` — el teardown era manual y minado (guardarraíl DNS, clasificador, pasos olvidados); artifacts SÍ tenían `mke artifact borrar` | resuelta | nuevo verbo `mke app borrar <app> --si` (inverso de nacer, doble llave en prod, --forge/--dir-local opt-in); helpers forgeDeleteRepo, removeStaticHosts, deleteRecordsByName(teardownApp); las 3 apps borradas con él de un comando |

| F9 | cierre (borrado) | teardown dejaba secretos huérfanos en el vault (`<app>/DATABASE_URL__<env>`): el vault no exponía borrar valor por API — basura acumulándose sin beneficio (feedback Santi) | resuelta (código+test); pendiente deploy prod | vault-mishi gana `DELETE /v1/secreto/:ns/:nombre` (autoriza como escribir, veta dev-pod, idempotente, auditado) + test; `mke app borrar` lo llama (helper `borrarValor`). Rama `vault-mishi@fuego-vault-borrar`. Los 3 huérfanos vivos se purgan al redeployar el vault (toca prod → espera OK). |

Merges a main hechos (con OK de Santi): `mke` (F1/F2/F5/F6 + F8 + F9-cliente) y `create-mishi-app` (F4/F7); ambos pusheados. Static-mishi limpiado y pusheado.
Pendiente de OK: `vault-mishi@fuego-vault-borrar` → main + deploy prod (el DELETE), y con el vault redeployado: purgar los secretos huérfanos `fogata|brasero|hoguera/DATABASE_URL__stage`.

Ramas con arreglos pendientes de OK de Santi para main: `mke@fuego-nacer`, `create-mishi-app@fuego-nacer` (quedan checked-out; el shim de mke corre esa rama).
