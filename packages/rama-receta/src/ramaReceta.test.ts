import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugFeature,
  ramaName,
  ramaHost,
  ramaServicioInterno,
  manifiestosRama,
  selectorDeRama,
  type K8sManifest,
} from "./ramaReceta.js";

const porKind = (ms: K8sManifest[], kind: string): K8sManifest =>
  ms.find((m) => m.kind === kind)!;

test("slugFeature: minúsculas, no-alfanumérico → guion, colapsa/recorta", () => {
  assert.equal(slugFeature("feat/Cobros-Omni"), "feat-cobros-omni");
  assert.equal(slugFeature("studio-escenarios"), "studio-escenarios");
  assert.equal(slugFeature("  raro//NOMBRE__x  "), "raro-nombre-x");
});

test("slugFeature: rama sin caracteres válidos revienta", () => {
  assert.throws(() => slugFeature("///"), /feature válido/);
});

test("ramaName: <app>-<slug>, saneado y recortado a 50", () => {
  assert.equal(ramaName("mishi-bank", "feat/login"), "mishi-bank-feat-login");
  const largo = ramaName("mishi-bank", "x".repeat(80));
  assert.ok(largo.length <= 50, `nombre demasiado largo: ${largo.length}`);
  assert.ok(!largo.endsWith("-"), "no debe terminar en guion");
});

test("ramaHost: sufijo -feat sobre el nombre", () => {
  assert.equal(ramaHost("mishi-bank", "feat/login"), "mishi-bank-feat-login-feat.mishi.com.co");
});

test("ramaServicioInterno: url in-cluster del service", () => {
  assert.equal(ramaServicioInterno("mishi-bank-feat-x"), "http://mishi-bank-feat-x.ramas.svc:80");
  assert.equal(ramaServicioInterno("x", "otro"), "http://x.otro.svc:80");
});

test("selectorDeRama: label de borrado", () => {
  assert.equal(selectorDeRama("mishi-bank-feat-x"), "mke.rama/name=mishi-bank-feat-x");
});

test("manifiestosRama: incluye los recursos esperados con el nombre y host", () => {
  const name = ramaName("mishi-bank", "feat/x");
  const host = ramaHost("mishi-bank", "feat/x");
  const ms = manifiestosRama({
    app: "mishi-bank",
    rama: "feat/x",
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
  });

  // recursos, en orden
  assert.deepEqual(
    ms.map((m) => m.kind),
    ["Namespace", "Secret", "ConfigMap", "Deployment", "Service", "Ingress"],
  );

  // namespace compartido `ramas`
  assert.equal((porKind(ms, "Namespace").metadata as any).name, "ramas");

  // nombre + label de borrado en cada recurso namespaced
  for (const kind of ["Secret", "ConfigMap", "Deployment", "Service", "Ingress"]) {
    const meta = porKind(ms, kind).metadata as any;
    assert.equal(meta.namespace, "ramas", `${kind} en ns ramas`);
    assert.equal(meta.labels["mke.rama/name"], name, `${kind} label de borrado`);
    assert.equal(meta.labels["mke.rama/managed"], "true");
    assert.equal(meta.labels["mke.rama/app"], "mishi-bank");
  }
  assert.equal((porKind(ms, "Deployment").metadata as any).name, name);

  // host del ingress
  const ing = porKind(ms, "Ingress").spec as any;
  assert.equal(ing.rules[0].host, host);

  // anatomía firmada del pod
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  assert.equal(podSpec.initContainers[0].name, "preparar");
  const imgs = podSpec.containers.map((c: any) => c.image);
  assert.ok(imgs.includes("postgres:16-alpine"), "sidecar postgres");
  assert.ok(imgs.includes("caddy:2-alpine"), "caddy front mismo origen");
  assert.ok(imgs.includes("mke-rama-runner:node22"), "imagen genérica del runner");
  const backend = podSpec.containers.find((c: any) => c.name === "backend");
  assert.ok(
    backend.env.some((e: any) => e.name === "RAMA_ENCENDIDA"),
    "env RAMA_ENCENDIDA",
  );
  assert.ok(
    backend.env.some(
      (e: any) => e.name === "DATABASE_URL" && e.value === "postgres://rama:rama@127.0.0.1:5432/rama",
    ),
    "DATABASE_URL al sidecar loopback",
  );

  // el REPO_URL va en el Secret (base64), nunca en claro
  const secret = porKind(ms, "Secret") as any;
  assert.ok(secret.data.REPO_URL, "REPO_URL en el Secret");
  assert.equal(
    Buffer.from(secret.data.REPO_URL, "base64").toString("utf8"),
    "https://github.com/mishicomco/mishi-bank.git",
  );
  assert.ok(
    !JSON.stringify(ms).includes("https://github.com/mishicomco/mishi-bank.git"),
    "REPO_URL no debe ir en claro en ningún manifiesto",
  );
});

test("manifiestosRama: emptyDir para postgres y workspace (efímero); imagen override", () => {
  const ms = manifiestosRama({
    app: "polla",
    rama: "r",
    repoUrl: "https://x/y.git",
    imagen: "runner:otra",
  });
  const podSpec = (ms.find((m) => m.kind === "Deployment")!.spec as any).template.spec;
  const empties = podSpec.volumes.filter((v: any) => v.emptyDir).length;
  assert.ok(empties >= 2, "workspace + pgdata efímeros");
  // la imagen override aplica al runner (init + backend), no a postgres/caddy
  assert.equal(podSpec.initContainers[0].image, "runner:otra");
});
