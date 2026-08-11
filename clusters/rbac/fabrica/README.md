# Artefactos de host de la fábrica de CI aislada (`mke-ci`)

**Por qué existe este directorio** (fricción hallada en la prueba de fuego
2026-08-11): los units systemd y el script de sync de la fábrica vivían SOLO en
`/etc/systemd/system/` y `/usr/local/bin/` de cada nodo, sin versionar. Si un
host se reinstala, no se recreaban desde git. Aquí quedan como **fuente de
reproducibilidad** (snapshots verificados en disco). El contexto completo está en
`../RUNBOOK-fabrica-aislada.md`; estos son los archivos crudos para re-bootstrapear.

> La fuente viva sigue siendo el host (systemd los ejecuta desde `/etc`); estos
> son la copia versionada para reinstalar/auditar. Si editas el host, actualiza
> también el archivo de acá (compuerta: mismo turno).

## Contenido

| archivo | destino en el host | notas |
|---|---|---|
| `forgejo-runner-prod.service.gamer` / `.laptop` | `/etc/systemd/system/forgejo-runner-prod.service` | runner #1. **`User=mke-ci`** |
| `forgejo-runner-prod-2.service.gamer` / `.laptop` | `…/forgejo-runner-prod-2.service` | runner #2 |
| `mke-ci-sync.service` + `.timer` | `/etc/systemd/system/` | pull de main del forge cada 15 min |
| `mke-ci-actualizar.gamer.sh` / `.laptop.sh` | `/usr/local/bin/mke-ci-actualizar` | `fetch`+`reset --hard origin/main`+`npm ci` si cambió `cli/package-lock.json` |

## Diferencias por nodo (NO son intercambiables)

- **uid de `mke-ci`**: gamer=1001, laptop=1002 → el `DOCKER_HOST` y `user@<uid>.service`
  del unit difieren (`/run/user/1001` vs `/run/user/1002`).
- **PATH**: gamer usa Node en `/opt/node/bin`; laptop usa el Node del sistema.
- **Nombre de los units**: en AMBOS nodos son `forgejo-runner-prod{,-2}`. ⚠️ **Trampa:**
  en el GAMER (que sirve **stage**) el nombre dice "prod" — es herencia del nombre
  viejo del runner, NO significa que toque producción. El runner del gamer se
  registra ante el forge como `pc-gamer-mke{,-2}` con label `mke-stage`; el del
  laptop como `laptop-mke{,-2}` con label `mke-prod`. En un incidente, **guíate por
  el HOST (gamer=stage, laptop=prod), no por el nombre del unit.**

## Re-bootstrap de un host (si se reinstala)

**El procedimiento COMPLETO desde un host limpio** (crear `mke-ci`, docker rootless,
las 4 credenciales, el runner, el RBAC) está en **`BOOTSTRAP-nodo.md`** — con los
comandos exactos, parametrizados por nodo, y marcando qué valores vienen de fuera
(vault/GPG/forge). Esta sección es solo el ÚLTIMO paso (instalar los units), que
asume las Fases A–E de ese bootstrap ya hechas:

```sh
# como root, con los archivos de ESTE nodo:
install -m644 forgejo-runner-prod.service.<nodo>   /etc/systemd/system/forgejo-runner-prod.service
install -m644 forgejo-runner-prod-2.service.<nodo> /etc/systemd/system/forgejo-runner-prod-2.service
install -m644 mke-ci-sync.service mke-ci-sync.timer /etc/systemd/system/
install -m755 mke-ci-actualizar.<nodo>.sh          /usr/local/bin/mke-ci-actualizar
systemctl daemon-reload
systemctl enable --now mke-ci-sync.timer
systemctl restart forgejo-runner-prod forgejo-runner-prod-2
```
