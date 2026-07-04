import { test } from "node:test";
import assert from "node:assert/strict";
import { ramaName, ramaHost, slugFeature } from "./mkeConfig.js";
import { manifiestosRama, edadDesde } from "./rama.js";

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

test("manifiestosRama: incluye los recursos esperados con el nombre y host", () => {
  const name = ramaName("mishi-bank", "feat/x");
  const host = ramaHost("mishi-bank", "feat/x");
  const yaml = manifiestosRama({
    app: "mishi-bank",
    rama: "feat/x",
    name,
    host,
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
  });
  // recursos
  for (const kind of ["kind: Namespace", "kind: Secret", "kind: ConfigMap", "kind: Deployment", "kind: Service", "kind: Ingress"]) {
    assert.ok(yaml.includes(kind), `falta ${kind}`);
  }
  // namespace compartido `ramas`
  assert.ok(yaml.includes("name: ramas"), "namespace ramas");
  // nombre en los recursos + label de borrado
  assert.ok(yaml.includes(`name: ${name}`), "nombre del recurso");
  assert.ok(yaml.includes(`mke.rama/name: ${name}`), "label de borrado");
  // host del ingress
  assert.ok(yaml.includes(`host: ${host}`), "host del ingress");
  // anatomía firmada del pod
  assert.ok(yaml.includes("initContainers:"), "initContainer");
  assert.ok(yaml.includes("image: postgres:16-alpine"), "sidecar postgres");
  assert.ok(yaml.includes("image: caddy:2-alpine"), "caddy front mismo origen");
  assert.ok(yaml.includes("mke-rama-runner:node22"), "imagen genérica del runner");
  assert.ok(yaml.includes("RAMA_ENCENDIDA"), "env RAMA_ENCENDIDA");
  assert.ok(yaml.includes("postgres://rama:rama@127.0.0.1:5432/rama"), "DATABASE_URL al sidecar loopback");
  // el REPO_URL va en el Secret (base64), nunca en claro
  assert.ok(!yaml.includes("https://github.com/mishicomco/mishi-bank.git"), "REPO_URL no debe ir en claro");
  assert.ok(yaml.includes("REPO_URL: "), "REPO_URL en el Secret");
});

test("manifiestosRama: emptyDir para postgres y workspace (efímero)", () => {
  const yaml = manifiestosRama({
    app: "polla", rama: "r", name: "polla-r", host: "polla-r-feat.mishi.com.co",
    repoUrl: "https://x/y.git",
  });
  const empties = yaml.match(/emptyDir: \{\}/g) ?? [];
  assert.ok(empties.length >= 2, "workspace + pgdata efímeros");
});

test("edadDesde: minutos/horas/días", () => {
  const ahora = new Date("2026-07-04T12:00:00Z").getTime();
  assert.equal(edadDesde("2026-07-04T11:30:00Z", ahora), "30m");
  assert.equal(edadDesde("2026-07-04T09:00:00Z", ahora), "3h");
  assert.equal(edadDesde("2026-07-01T12:00:00Z", ahora), "3d");
  assert.equal(edadDesde(undefined, ahora), "?");
});
