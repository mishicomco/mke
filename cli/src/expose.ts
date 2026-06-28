import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envOrThrow, hostFor } from "./mkeConfig.js";
import { run, ok, bad, info } from "./sh.js";
import { ensureDns } from "./dns.js";
import { doctor } from "./doctor.js";

export interface ExposeOpts {
  /** servicio del HOST: crea ExternalName→host.k3d.internal + ingress al puerto */
  hostPort?: number;
  /** servicio del CLUSTER ya existente: name:port */
  svc?: string;
  /** override del host público (cuando el subdominio != id del app) */
  host?: string;
  /** path del ingress (default /) */
  path?: string;
}

/** Genera el ingress (+ ExternalName si es host) y lo aplica + DNS + verifica. */
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
    docs.push(
      yamlExternalName(svcName, spec.namespace, opts.hostPort, app),
    );
  } else {
    const [n, p] = opts.svc!.split(":");
    if (!n || !p) throw new Error("--svc debe ser name:port");
    svcName = n;
    svcPort = Number(p);
  }

  docs.push(yamlIngress(app, host, spec.namespace, svcName, svcPort, path));
  const manifest = docs.join("\n---\n");

  const file = join(tmpdir(), `mke-expose-${app}-${env}.yaml`);
  writeFileSync(file, manifest);
  console.log(info(`aplicando ingress en ${spec.context}/${spec.namespace} para ${host}`));

  // asegura namespace
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

function yamlExternalName(name: string, ns: string, port: number, app: string): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: ${app}
    app.kubernetes.io/part-of: mke
spec:
  type: ExternalName
  externalName: host.k3d.internal
  ports:
    - port: ${port}
      targetPort: ${port}`;
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
