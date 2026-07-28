import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envOrThrow, hostFor } from "./mkeConfig.js";
import { run, ok, bad, info } from "./sh.js";
import { ensureDns } from "./dns.js";
import { doctor } from "./doctor.js";

export interface ExposeOpts {
  /** servicio del HOST (systemd): Service sin selector + Endpoints → gateway:port */
  hostPort?: number;
  /** servicio del CLUSTER ya existente: name:port */
  svc?: string;
  /** override del host público (cuando el subdominio != id del app) */
  host?: string;
  /** override de la IP del host (gateway docker) para modo host-port */
  hostIp?: string;
  /** path del ingress (default /) */
  path?: string;
}

/** Genera el ingress (+ Service/Endpoints si es host) y lo aplica + DNS + verifica. */
export async function expose(app: string, env: string, opts: ExposeOpts): Promise<void> {
  const spec = envOrThrow(env);
  const host = opts.host ?? hostFor(app, env);
  const path = opts.path ?? "/";

  if (!opts.hostPort && !opts.svc) {
    throw new Error("indicá --host-port N (servicio del host) o --svc name:port (servicio del cluster)");
  }

  let svcName: string;
  let svcPort: number;
  const docs: string[] = [];

  if (opts.hostPort) {
    svcName = `${app}-host`;
    svcPort = opts.hostPort;
    const ip = opts.hostIp ?? spec.hostGatewayIp;
    docs.push(yamlHostService(svcName, spec.namespace, opts.hostPort, ip, app));
  } else {
    const [n, p] = opts.svc!.split(":");
    if (!n || !p) throw new Error("--svc debe ser name:port");
    svcName = n;
    svcPort = Number(p);
  }

  // GUARDARRAÍL (post-mortem 2026-07-28): `apply` de un Ingress con el nombre de
  // uno existente lo REEMPLAZA entero — un expose de static-mishi con un solo
  // host tumbó TODOS los fronts de prod ~2h. Si ya existe un Ingress `<app>` con
  // hosts que este expose no incluye, abortar: ese ingress es dueño de su repo
  // (apply -k del overlay), no de este verbo.
  const vivo = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "get", "ingress", app, "-o", "jsonpath={range .spec.rules[*]}{.host}{\"\\n\"}{end}",
  ]);
  if (vivo.code === 0) {
    const hostsVivos = vivo.stdout.split("\n").map((h) => h.trim()).filter(Boolean);
    const perderia = hostsVivos.filter((h) => h !== host);
    if (perderia.length > 0) {
      console.log(bad(`el Ingress ${app} (${spec.namespace}) ya existe con ${hostsVivos.length} host(s) y este expose lo REEMPLAZARÍA perdiendo: ${perderia.join(", ")}`));
      console.log(info("  ese ingress lo gobierna su repo (kubectl apply -k del overlay / mke deploy) — agrega el host ahí"));
      process.exitCode = 1;
      return;
    }
  }

  docs.push(yamlIngress(app, host, spec.namespace, svcName, svcPort, path));
  const manifest = docs.join("\n---\n");

  const file = join(tmpdir(), `mke-expose-${app}-${env}.yaml`);
  writeFileSync(file, manifest);
  console.log(info(`aplicando ingress en ${spec.context}/${spec.namespace} para ${host}`));

  await run("kubectl", ["--context", spec.context, "create", "namespace", spec.namespace]);

  const apply = await run("kubectl", ["--context", spec.context, "apply", "-f", file]);
  if (apply.code !== 0) {
    console.log(bad(`apply falló: ${apply.stderr || apply.stdout}`));
    console.log(info(`manifest quedó en ${file}`));
    return;
  }
  console.log(ok(apply.stdout.split("\n").join(" · ")));

  await ensureDns(host, env);
  await doctor(host, path === "/" ? "/health" : path);
}

/** Service sin selector + Endpoints a la IP del host (gateway docker). Traefik lo enruta. */
function yamlHostService(name: string, ns: string, port: number, ip: string, app: string): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: ${app}
    app.kubernetes.io/part-of: mke
spec:
  ports:
    - port: ${port}
      targetPort: ${port}
      protocol: TCP
---
apiVersion: v1
kind: Endpoints
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: ${app}
    app.kubernetes.io/part-of: mke
subsets:
  - addresses:
      - ip: ${ip}
    ports:
      - port: ${port}
        protocol: TCP`;
}

function yamlIngress(
  app: string,
  host: string,
  ns: string,
  svcName: string,
  svcPort: number,
  path: string,
): string {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${app}
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: ${app}
    app.kubernetes.io/part-of: mke
spec:
  ingressClassName: traefik
  rules:
    - host: ${host}
      http:
        paths:
          - path: ${path}
            pathType: Prefix
            backend:
              service:
                name: ${svcName}
                port:
                  number: ${svcPort}`;
}
