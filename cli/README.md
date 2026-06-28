# `mke` — CLI de plataforma MKE

Operaciones deterministas de MKE como **programa**, no como prosa que un agente
re-interpreta cada vez. v1: `expose`, `dns`, `doctor`. El build/deploy
(`scripts/deploy-app.sh`, `bootstrap-prod.sh`) se migran después.

## Instalar

```bash
npm install                              # en mke/cli (instala tsx)
ln -s ~/mishicomco/mke/cli/mke ~/.local/bin/mke   # o donde tengas PATH
mke help
```

## Comandos

```bash
# Exponer un servicio del HOST (systemd) en <app>-<env>.mishi.com.co
# (crea ExternalName→host.k3d.internal + ingress + DNS + verifica)
mke expose agents-mishi stage --host-port 8787

# Exponer un servicio del CLUSTER ya existente
mke expose mishi-bank stage --svc mishi-bank:80

# Crear/reparar solo el DNS al tunnel correcto del entorno
mke dns agents-stage.mishi.com.co stage

# Diagnosticar la cadena pública y saber QUÉ capa está rota
mke doctor agents-stage.mishi.com.co
```

`--host <fqdn>` cuando el subdominio ≠ id del app (p.ej. `omni-whatsapp` → `omni`).

## Conocimiento horneado (antes se re-diagnosticaba a mano)

Vive en `src/mkeConfig.ts`. Lo no obvio:

- **stage y prod son namespaces del MISMO cluster `k3d-mke-prod`.** El contexto
  `k3d-mke-stage` existe pero su namespace `stage` está vacío (legacy). Aplicar al
  contexto equivocado da `namespaces "stage" not found`.
- **cloudflared corre como tunnels del HOST** (systemd: `mke-stage`, `mke-prod`,
  `mke-local`, `lmstudio`, `mke-ssh`), **no in-cluster** como dice el viejo
  `AI_CONTEXT.md` de mke. Un tunnel (UUID) por entorno.
- **`cloudflared tunnel route dns <NOMBRE> <host>` puede enrutar al tunnel
  equivocado** (mandó a `lmstudio`). Usar SIEMPRE el UUID + `--overwrite-dns`.

## Diagnóstico de `doctor` (cómo leer la cadena)

`DNS → tunnel cloudflared → Traefik → ingress → backend`

| Síntoma | Capa rota | Fix |
|---|---|---|
| DNS no resuelve | no hay CNAME | `mke expose` (crea DNS+ingress) |
| `530` / cuerpo `1033` | tunnel sin ruta al host | `mke dns <host> <env>` |
| `404` | Traefik sin ingress para el host | `mke expose ...` |
| `200/401/403/302` | sano (backend alcanzable) | — |
| `000` | timeout / inalcanzable | revisar tunnel/servicio |
