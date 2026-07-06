import { test } from "node:test";
import assert from "node:assert/strict";
import { devName, devHost } from "./mkeConfig.js";
import { manifiestosDev } from "@mishicomco/dev-receta";
import { edadDesde, parseEnvExtra } from "./dev.js";

type M = Record<string, unknown>;
const porKind = (ms: M[], kind: string): M => ms.find((m) => m.kind === kind)!;

test("devName/devHost re-exportados por mkeConfig", () => {
  assert.equal(devName("mishi-bank"), "mishi-bank-dev");
  assert.equal(devName("mishi-bank", "azul"), "mishi-bank-azul-dev");
  assert.equal(devHost("mishi-bank"), "mishi-bank-dev-feat.mishi.com.co");
});

test("manifiestosDev: pod de iteración con ns dev y host -feat", () => {
  const name = devName("mishi-bank");
  const host = devHost("mishi-bank");
  const ms = manifiestosDev({
    app: "mishi-bank",
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
  }) as M[];
  assert.deepEqual(
    ms.map((m) => m.kind),
    ["Namespace", "Secret", "ConfigMap", "Deployment", "Service", "Ingress"],
  );
  assert.equal((porKind(ms, "Namespace").metadata as any).name, "dev");
  assert.equal((porKind(ms, "Deployment").metadata as any).name, name);
  assert.equal((porKind(ms, "Deployment").metadata as any).labels["mke.dev/name"], name);
  assert.equal(((porKind(ms, "Ingress").spec as any).rules[0].host), host);
  // PREVIEW=true siempre en el contenedor dev
  const dev = (porKind(ms, "Deployment").spec as any).template.spec.containers.find(
    (c: any) => c.name === "dev",
  );
  assert.ok(dev.env.some((e: any) => e.name === "PREVIEW" && e.value === "true"));
  // el REPO_URL nunca en claro
  assert.ok(
    !JSON.stringify(ms).includes("https://github.com/mishicomco/mishi-bank.git"),
    "REPO_URL no debe ir en claro",
  );
});

test("parseEnvExtra: K=V,K=V → objeto; vacío → undefined", () => {
  assert.deepEqual(parseEnvExtra("CONNECT_URL=http://c.svc,CONNECT_JWKS_URL=http://c.svc/jwks"), {
    CONNECT_URL: "http://c.svc",
    CONNECT_JWKS_URL: "http://c.svc/jwks",
  });
  assert.equal(parseEnvExtra(undefined), undefined);
  assert.equal(parseEnvExtra(""), undefined);
  // tolera un valor con '=' interno
  assert.deepEqual(parseEnvExtra("TOKEN=a=b"), { TOKEN: "a=b" });
});

test("edadDesde: minutos/horas/días", () => {
  const ahora = new Date("2026-07-06T12:00:00Z").getTime();
  assert.equal(edadDesde("2026-07-06T11:30:00Z", ahora), "30m");
  assert.equal(edadDesde("2026-07-06T09:00:00Z", ahora), "3h");
  assert.equal(edadDesde("2026-07-03T12:00:00Z", ahora), "3d");
  assert.equal(edadDesde(undefined, ahora), "?");
});
