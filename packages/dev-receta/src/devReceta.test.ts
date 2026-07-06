import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugDev,
  devName,
  devHost,
  devServicioInterno,
  selectorDeDev,
  viteDevConfig,
  manifiestosDev,
  DEV_VITE_PORT,
  type K8sManifest,
} from "./devReceta.js";

const porKind = (ms: K8sManifest[], kind: string): K8sManifest =>
  ms.find((m) => m.kind === kind)!;

test("slugDev: minúsculas, no-alfanumérico → guion, colapsa/recorta", () => {
  assert.equal(slugDev("feat/Cobros-Omni"), "feat-cobros-omni");
  assert.equal(slugDev("  raro//NOMBRE__x  "), "raro-nombre-x");
});

test("slugDev: sin caracteres válidos revienta", () => {
  assert.throws(() => slugDev("///"), /slug válido/);
});

test("devName: <app>-dev, y <app>-<nombre>-dev con --nombre; recorta a 50", () => {
  assert.equal(devName("mishi-bank"), "mishi-bank-dev");
  assert.equal(devName("mishi-bank", "azul"), "mishi-bank-azul-dev");
  const largo = devName("mishi-bank", "x".repeat(80));
  assert.ok(largo.length <= 50, `nombre demasiado largo: ${largo.length}`);
  assert.ok(!largo.endsWith("-"), "no debe terminar en guion");
});

test("devHost: sufijo -feat sobre el nombre (cae bajo el guardarraíl DNS)", () => {
  assert.equal(devHost("mishi-bank"), "mishi-bank-dev-feat.mishi.com.co");
  assert.equal(devHost("mishi-bank", "azul"), "mishi-bank-azul-dev-feat.mishi.com.co");
  assert.ok(devHost("polla").endsWith("-feat.mishi.com.co"), "termina en -feat.mishi.com.co");
});

test("devServicioInterno: url in-cluster del service", () => {
  assert.equal(devServicioInterno("mishi-bank-dev"), "http://mishi-bank-dev.dev.svc:80");
  assert.equal(devServicioInterno("x", "otro"), "http://x.otro.svc:80");
});

test("selectorDeDev: label de borrado", () => {
  assert.equal(selectorDeDev("mishi-bank-dev"), "mke.dev/name=mishi-bank-dev");
});

test("viteDevConfig: hereda vite.config + host 0.0.0.0 + allowedHosts + HMR wss:443", () => {
  const cfg = viteDevConfig(DEV_VITE_PORT);
  assert.match(cfg, /import base from "\.\/vite\.config"/, "hereda el vite.config del app");
  assert.match(cfg, /mergeConfig/, "usa mergeConfig");
  assert.match(cfg, /host: "0\.0\.0\.0"/);
  assert.match(cfg, /allowedHosts: true/);
  assert.match(cfg, /hmr: \{ protocol: "wss", clientPort: 443 \}/, "HMR por wss:443");
  assert.match(cfg, new RegExp(`port: ${DEV_VITE_PORT}`), "el puerto de vite");
});

test("manifiestosDev: recursos esperados, ns dev, nombre y host", () => {
  const name = devName("mishi-bank");
  const host = devHost("mishi-bank");
  const ms = manifiestosDev({
    app: "mishi-bank",
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
  });

  assert.deepEqual(
    ms.map((m) => m.kind),
    ["Namespace", "Secret", "ConfigMap", "Deployment", "Service", "Ingress"],
  );

  // namespace PROPIO `dev` (separado de `ramas`)
  assert.equal((porKind(ms, "Namespace").metadata as any).name, "dev");

  for (const kind of ["Secret", "ConfigMap", "Deployment", "Service", "Ingress"]) {
    const meta = porKind(ms, kind).metadata as any;
    assert.equal(meta.namespace, "dev", `${kind} en ns dev`);
    assert.equal(meta.labels["mke.dev/name"], name, `${kind} label de borrado`);
    assert.equal(meta.labels["mke.dev/managed"], "true");
    assert.equal(meta.labels["mke.dev/app"], "mishi-bank");
  }
  assert.equal((porKind(ms, "Deployment").metadata as any).name, name);
  assert.equal(((porKind(ms, "Ingress").spec as any).rules[0].host), host);
});

test("manifiestosDev: anatomía del pod de iteración (dev real + caddy + postgres)", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;

  assert.equal(podSpec.initContainers[0].name, "preparar");
  const nombres = podSpec.containers.map((c: any) => c.name).sort();
  assert.deepEqual(nombres, ["dev", "postgres", "web"]);

  const imgs = podSpec.containers.map((c: any) => c.image);
  assert.ok(imgs.includes("postgres:16-alpine"), "sidecar postgres");
  assert.ok(imgs.includes("caddy:2-alpine"), "caddy proxy");
  assert.ok(imgs.includes("mke-dev-runner:node22"), "imagen genérica del runner");

  // el contenedor dev arranca boot-dev.sh y trae PREVIEW=true + DATABASE_URL loopback
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  assert.deepEqual(dev.command, ["sh", "/dev/boot-dev.sh"]);
  assert.ok(
    dev.env.some((e: any) => e.name === "PREVIEW" && e.value === "true"),
    "PREVIEW=true siempre",
  );
  assert.ok(
    dev.env.some(
      (e: any) => e.name === "DATABASE_URL" && e.value === "postgres://dev:dev@127.0.0.1:5432/dev",
    ),
    "DATABASE_URL al sidecar loopback",
  );
});

test("manifiestosDev: emptyDir para workspace y pgdata (efímero); imagen override", () => {
  const ms = manifiestosDev({ app: "polla", repoUrl: "https://x/y.git", imagen: "runner:otra" });
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  const empties = podSpec.volumes.filter((v: any) => v.emptyDir).length;
  assert.ok(empties >= 2, "workspace + pgdata efímeros");
  assert.equal(podSpec.initContainers[0].image, "runner:otra");
});

test("manifiestosDev: el ConfigMap trae los scripts, la vite config y el Caddyfile", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const cm = porKind(ms, "ConfigMap") as any;
  for (const f of ["prepare.sh", "boot-dev.sh", "reset-db.sh", "rama.sh", "pull.sh", "poll.sh", "vite.dev.mke.config.ts", "Caddyfile"]) {
    assert.ok(cm.data[f], `ConfigMap trae ${f}`);
  }
  // caddy proxya /api al backend y todo lo demás a vite (websockets/HMR)
  assert.match(cm.data.Caddyfile, /handle \/api\/\*/, "caddy: /api al backend");
  assert.match(cm.data.Caddyfile, /reverse_proxy 127\.0\.0\.1:5173/, "caddy: resto a vite");
});

test("manifiestosDev: envExtra por app + seedCmd + poll se inyectan en dev", () => {
  const ms = manifiestosDev({
    app: "mishi-bank",
    repoUrl: "https://x/y.git",
    pollSeconds: 20,
    seedCmd: "npm run seed -w apps/backend",
    envExtra: { CONNECT_URL: "http://connect.dev.svc", CONNECT_JWKS_URL: "http://connect.dev.svc/jwks" },
  });
  const dev = (porKind(ms, "Deployment").spec as any).template.spec.containers.find(
    (c: any) => c.name === "dev",
  );
  const val = (n: string) => dev.env.find((e: any) => e.name === n)?.value;
  assert.equal(val("CONNECT_URL"), "http://connect.dev.svc");
  assert.equal(val("CONNECT_JWKS_URL"), "http://connect.dev.svc/jwks");
  assert.equal(val("SEED_CMD"), "npm run seed -w apps/backend");
  assert.equal(val("POLL_SECONDS"), "20");
});

test("manifiestosDev: --nombre da recursos y host distintos (varios por app)", () => {
  const ms = manifiestosDev({ app: "mishi-bank", nombre: "azul", repoUrl: "https://x/y.git" });
  assert.equal((porKind(ms, "Deployment").metadata as any).name, "mishi-bank-azul-dev");
  assert.equal(
    ((porKind(ms, "Ingress").spec as any).rules[0].host),
    "mishi-bank-azul-dev-feat.mishi.com.co",
  );
  assert.equal((porKind(ms, "Deployment").metadata as any).labels["mke.dev/nombre"], "azul");
});

test("manifiestosDev: el REPO_URL va en el Secret (base64), nunca en claro", () => {
  const ms = manifiestosDev({
    app: "mishi-bank",
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
  });
  const secret = porKind(ms, "Secret") as any;
  assert.equal(
    Buffer.from(secret.data.REPO_URL, "base64").toString("utf8"),
    "https://github.com/mishicomco/mishi-bank.git",
  );
  assert.ok(
    !JSON.stringify(ms).includes("https://github.com/mishicomco/mishi-bank.git"),
    "REPO_URL no debe ir en claro en ningún manifiesto",
  );
});

test("manifiestosDev: annotations vivos rama/sha en el Deployment", () => {
  const ms = manifiestosDev({ app: "mishi-bank", rama: "feat/x", repoUrl: "https://x/y.git" });
  const ann = (porKind(ms, "Deployment").metadata as any).annotations;
  assert.equal(ann["mke.dev/rama"], "feat/x");
  assert.ok("mke.dev/sha" in ann, "annotation de sha presente (la llena el CLI)");
});
