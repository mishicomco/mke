import { ENVS } from "./mkeConfig.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";

/**
 * Diagnostica la cadena pública de un host y dice QUÉ CAPA está rota:
 *   DNS (Cloudflare) → tunnel cloudflared → Traefik → ingress → backend
 *
 * Interpretación clave (lo que antes se adivinaba):
 *   - sin DNS            → no existe el record; corré `mke dns` o `mke expose`.
 *   - 530 / "1033"       → el tunnel no tiene ruta al host (CNAME mal apuntado).
 *   - 404               → llegó a Traefik pero NO hay ingress para el host → `mke expose`.
 *   - 200/401/403/302    → backend alcanzable (sano).
 *   - 000               → timeout / inalcanzable.
 */
export async function doctor(host: string, healthPath = "/health"): Promise<void> {
  console.log(`\n  diagnóstico de ${host}\n`);

  // 1) DNS
  const dnsRes = await run("getent", ["hosts", host]);
  const hasDns = dnsRes.code === 0 && dnsRes.stdout.length > 0;
  if (hasDns) {
    console.log(ok(`DNS resuelve  ${dim(dnsRes.stdout.split("\n")[0])}`));
  } else {
    console.log(bad("DNS no resuelve — no existe el record CNAME"));
    console.log(info("  fix: mke expose <app> <env> ...  (crea DNS + ingress)"));
    return;
  }

  // 2) HTTP a través de la cadena
  const url = `https://${host}${healthPath}`;
  const http = await run("curl", [
    "-s",
    "-m",
    "15",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    url,
  ]);
  const code = http.stdout.trim();
  const body = await run("curl", ["-s", "-m", "15", url]);
  const is1033 = /1033|argo tunnel|error code: 1033/i.test(body.stdout);

  if (code === "000") {
    console.log(bad(`${url} inalcanzable (timeout)`));
  } else if (is1033 || code === "530") {
    console.log(bad(`tunnel sin ruta al host (1033/${code}) — CNAME apunta a un tunnel que no sirve ${host}`));
    console.log(info("  fix: mke dns <host> <env>  (re-apunta al tunnel correcto del entorno)"));
  } else if (code === "404") {
    console.log(warn(`404 — llegó a Traefik pero NO hay ingress para ${host}`));
    console.log(info("  fix: mke expose <app> <env> --host-port N | --svc name:port"));
  } else if (/^(200|201|301|302|401|403)$/.test(code)) {
    console.log(ok(`backend alcanzable (HTTP ${code})`));
  } else {
    console.log(warn(`HTTP ${code} — respuesta inesperada`));
  }

  // 3) ¿existe el ingress en algún cluster/namespace conocido?
  const seen: string[] = [];
  for (const [env, spec] of Object.entries(ENVS)) {
    const r = await run("kubectl", [
      "--context",
      spec.context,
      "get",
      "ingress",
      "-n",
      spec.namespace,
      "-o",
      "jsonpath={range .items[*]}{.spec.rules[*].host}{\"\\n\"}{end}",
    ]);
    if (r.code === 0 && r.stdout.split("\n").some((h) => h.trim() === host)) {
      seen.push(`${env} (${spec.context}/${spec.namespace})`);
    }
  }
  if (seen.length) {
    console.log(ok(`ingress presente en: ${seen.join(", ")}`));
  } else {
    console.log(warn("ningún ingress declara este host en local/stage/prod"));
  }
  console.log("");
}
