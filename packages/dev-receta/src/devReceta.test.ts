import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugDev,
  devLiveBase,
  viteDevConfig,
  parseDotEnv,
  mergeDevEnv,
  clavesViteTokenProhibidas,
  DEV_VITE_PORT,
  previewPodName,
  previewPodHost,
  selectorDePreview,
  manifiestosPreview,
  PREVIEW_SIN_LEASE,
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

test("viteDevConfig: hereda vite.config + host 0.0.0.0 + allowedHosts + HMR wss:443", () => {
  const cfg = viteDevConfig(DEV_VITE_PORT);
  assert.match(cfg, /import base from "\.\/vite\.config"/, "hereda el vite.config del app");
  assert.match(cfg, /mergeConfig/, "usa mergeConfig");
  assert.match(cfg, /host: "0\.0\.0\.0"/);
  assert.match(cfg, /allowedHosts: true/);
  assert.match(cfg, /hmr: \{ protocol: "wss", clientPort: 443 \}/, "HMR por wss:443");
  assert.match(cfg, new RegExp(`port: ${DEV_VITE_PORT}`), "el puerto de vite");
});

test("devLiveBase: prefijo /live/<app>/ del modo EMBED", () => {
  assert.equal(devLiveBase("mishi-bank"), "/live/mishi-bank/");
  assert.equal(devLiveBase("polla"), "/live/polla/");
});

test("viteDevConfig: sin viteBase NO fija base (modo normal)", () => {
  const cfg = viteDevConfig(DEV_VITE_PORT);
  assert.ok(!/\bbase:/.test(cfg), "sin base en modo normal");
});

test("viteDevConfig: con viteBase fija base (modo EMBED) sin tocar hmr", () => {
  const cfg = viteDevConfig(DEV_VITE_PORT, "/live/mishi-bank/");
  assert.match(cfg, /base: "\/live\/mishi-bank\/"/, "base al prefijo live");
  // hmr sigue siendo wss:443 (el path del ws sale del base solo — no lo pisamos)
  assert.match(cfg, /hmr: \{ protocol: "wss", clientPort: 443 \}/);
});

test("parseDotEnv: K=V, ignora vacías/comentarios, recorta clave y valor", () => {
  const txt = [
    "# config pública de la rama",
    "VITE_CONNECT_URL=https://connect.dev.svc",
    "  VITE_GOOGLE_CLIENT_ID = abc.apps.googleusercontent.com  ",
    "",
    "# comentario",
    "SIN_IGUAL",
    "=sin-clave",
    "TOKEN=a=b=c",
  ].join("\n");
  assert.deepEqual(parseDotEnv(txt), {
    VITE_CONNECT_URL: "https://connect.dev.svc",
    VITE_GOOGLE_CLIENT_ID: "abc.apps.googleusercontent.com",
    TOKEN: "a=b=c",
  });
  assert.deepEqual(parseDotEnv(""), {});
});

test("mergeDevEnv: PRECEDENCIA — el --env del CLI GANA sobre el archivo dev.env", () => {
  const archivo = { VITE_CONNECT_URL: "https://del-archivo", VITE_X: "1" };
  const cli = { VITE_CONNECT_URL: "https://del-cli" };
  assert.deepEqual(mergeDevEnv(archivo, cli), {
    VITE_CONNECT_URL: "https://del-cli", // override gana
    VITE_X: "1", // el archivo rellena lo que el CLI no trae
  });
  // sin overrides, el archivo manda tal cual
  assert.deepEqual(mergeDevEnv(archivo), archivo);
  assert.deepEqual(mergeDevEnv({}, cli), cli);
});

test("clavesViteTokenProhibidas: detecta VITE_*TOKEN* (caso del Bearer horneado en el bundle)", () => {
  assert.deepEqual(clavesViteTokenProhibidas({ VITE_STUDIO_TOKEN: "x" }), ["VITE_STUDIO_TOKEN"]);
  assert.deepEqual(clavesViteTokenProhibidas({ VITE_Some_Token: "x" }), ["VITE_Some_Token"]);
  assert.deepEqual(
    clavesViteTokenProhibidas({ VITE_CONNECT_URL: "x", VITE_GOOGLE_CLIENT_ID: "y" }),
    [],
    "config pública normal no dispara el candado",
  );
  assert.deepEqual(
    clavesViteTokenProhibidas({}),
    [],
  );
});

// ─── preview-pod (`mke preview`) ─────────────────────────────────────────────

test("previewPodName: <app>-<slug(rama)>, SIEMPRE con la rama, recorta a 50", () => {
  assert.equal(previewPodName("mishi-bank", "feat/cobros"), "mishi-bank-feat-cobros");
  const largo = previewPodName("mishi-bank", "x".repeat(80));
  assert.ok(largo.length <= 50, `nombre demasiado largo: ${largo.length}`);
  assert.ok(!largo.endsWith("-"), "no debe terminar en guion");
});

test("previewPodHost: BARE, sin sufijo — un solo label DNS", () => {
  assert.equal(previewPodHost("mishi-bank", "feat/cobros"), "mishi-bank-feat-cobros.mishi.com.co");
  assert.ok(!previewPodHost("mishi-bank", "main").includes("-pre"), "sin el viejo sufijo -pre");
  assert.ok(!previewPodHost("mishi-bank", "main").includes("-feat"), "sin el sufijo -feat de dev/feature");
});

test("selectorDePreview: label por app×rama (rama slugueada)", () => {
  assert.equal(selectorDePreview("mishi-bank", "feat/Cobros"), "mke.preview/app=mishi-bank,mke.preview/rama=feat-cobros");
});

test("manifiestosPreview: recursos esperados, ns preview, SIDECAR postgres + DATABASE_URL loopback", () => {
  const ms = manifiestosPreview({
    app: "mishi-bank",
    rama: "feat/cobros",
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
    leaseId: "lease-1",
    leaseToken: "lease-tok",
  });
  assert.deepEqual(
    ms.map((m) => m.kind),
    ["Namespace", "Secret", "Secret", "ConfigMap", "Deployment", "Service", "Ingress"],
    "git + lease Secrets",
  );
  assert.equal((porKind(ms, "Namespace").metadata as any).name, "preview");
  const name = previewPodName("mishi-bank", "feat/cobros");
  assert.equal((porKind(ms, "Deployment").metadata as any).name, name);
  assert.equal((porKind(ms, "Deployment").metadata as any).labels["mke.preview/app"], "mishi-bank");
  assert.equal((porKind(ms, "Deployment").metadata as any).labels["mke.preview/rama"], "feat-cobros");
  assert.equal((porKind(ms, "Deployment").metadata as any).labels["mke.preview/lease"], "lease-1");
  assert.equal(((porKind(ms, "Ingress").spec as any).rules[0].host), previewPodHost("mishi-bank", "feat/cobros"));

  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  const nombres = podSpec.containers.map((c: any) => c.name).sort();
  assert.deepEqual(nombres, ["dev", "postgres", "web"], "SIDECAR postgres: la DB muere con el pod");
  assert.ok(podSpec.volumes.some((v: any) => v.name === "pgdata" && v.emptyDir), "pgdata emptyDir efímero");

  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  assert.deepEqual(dev.command, ["sh", "/mke/boot-preview.sh"]);
  const val = (n: string) => dev.env.find((e: any) => e.name === n)?.value;
  assert.equal(val("PREVIEW"), "true");
  assert.equal(val("PREVIEW_MODE"), "true");
  assert.equal(val("DATABASE_URL"), "postgres://dev:dev@127.0.0.1:5432/dev", "DATABASE_URL al sidecar loopback");
});

test("manifiestosPreview: leaseToken → Secret <name>-lease + env LEASE_TOKEN, nunca en claro; config al env", () => {
  const ms = manifiestosPreview({
    app: "mishi-bank",
    rama: "main",
    repoUrl: "https://x/y.git",
    leaseId: "lease-9",
    leaseToken: "tok_secreto",
    config: { IDENTITY_URL: "http://identity-preview.dev.svc:3000" },
    npmToken: "ghp_secreto",
  });
  const leaseSecret = ms.find((m) => m.kind === "Secret" && (m.metadata as any).name === "mishi-bank-main-lease") as any;
  assert.ok(leaseSecret, "Secret <name>-lease presente");
  assert.equal(Buffer.from(leaseSecret.data.LEASE_TOKEN, "base64").toString("utf8"), "tok_secreto");
  assert.ok(!JSON.stringify(ms).includes("tok_secreto"), "leaseToken nunca en claro");
  assert.ok(!JSON.stringify(ms).includes("ghp_secreto"), "npmToken nunca en claro");

  const dev = (porKind(ms, "Deployment").spec as any).template.spec.containers.find((c: any) => c.name === "dev");
  assert.ok(dev.env.some((e: any) => e.name === "LEASE_TOKEN" && e.valueFrom?.secretKeyRef?.name === "mishi-bank-main-lease"), "LEASE_TOKEN por secretKeyRef");
  assert.ok(dev.env.some((e: any) => e.name === "IDENTITY_URL" && e.value === "http://identity-preview.dev.svc:3000"), "config al env en claro");
});

test("manifiestosPreview: DEGRADACIÓN sin leaseToken → sin Secret de lease, label lease=sin-lease, sin env LEASE_TOKEN", () => {
  const ms = manifiestosPreview({ app: "mishi-bank", rama: "main", repoUrl: "https://x/y.git", leaseId: PREVIEW_SIN_LEASE });
  assert.ok(!ms.some((m) => m.kind === "Secret" && (m.metadata as any).name === "mishi-bank-main-lease"), "sin Secret de lease");
  assert.equal((porKind(ms, "Deployment").metadata as any).labels["mke.preview/lease"], "sin-lease");
  const dev = (porKind(ms, "Deployment").spec as any).template.spec.containers.find((c: any) => c.name === "dev");
  assert.ok(!dev.env.some((e: any) => e.name === "LEASE_TOKEN"), "sin env LEASE_TOKEN en modo degradado");
});

test("manifiestosPreview: sin --live NO hay annotation live; con --live sí", () => {
  const sinLive = manifiestosPreview({ app: "mishi-bank", rama: "main", repoUrl: "https://x/y.git", leaseId: "l1", leaseToken: "t" });
  assert.ok(!("mke.dev/live" in ((porKind(sinLive, "Deployment").metadata as any).annotations)));
  const conLive = manifiestosPreview({ app: "mishi-bank", rama: "main", repoUrl: "https://x/y.git", leaseId: "l1", leaseToken: "t", live: true });
  assert.equal(((porKind(conLive, "Deployment").metadata as any).annotations)["mke.dev/live"], "true");
});

// ─── FORMA de la app (derivada por el CLI; default = completa) ───────────────

test("manifiestosPreview: backend-only — sin vite config, Caddyfile todo→backend, readiness /health", () => {
  const ms = manifiestosPreview({
    app: "chrome-mishi", rama: "perfiles", repoUrl: "https://x/y.git",
    leaseId: PREVIEW_SIN_LEASE, frontend: false,
  });
  const cm = porKind(ms, "ConfigMap") as any;
  assert.ok(!("vite.dev.mke.config.ts" in cm.data), "sin config de vite");
  assert.ok(!cm.data.Caddyfile.includes("5173"), "caddy no apunta a vite");
  assert.match(cm.data.Caddyfile, /reverse_proxy 127\.0\.0\.1:3000/, "todo al backend");
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  const web = podSpec.containers.find((c: any) => c.name === "web");
  assert.equal(web.readinessProbe.httpGet.path, "/health", "readiness prueba caddy→backend");
  assert.deepEqual(podSpec.containers.map((c: any) => c.name).sort(), ["dev", "postgres", "web"], "el sidecar postgres sigue (hay backend)");
});

test("manifiestosPreview: frontend-only — sin sidecar postgres, sin DATABASE_URL, readiness /", () => {
  const ms = manifiestosPreview({
    app: "solo-front", rama: "main", repoUrl: "https://x/y.git",
    leaseId: PREVIEW_SIN_LEASE, backend: false,
  });
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  assert.deepEqual(podSpec.containers.map((c: any) => c.name).sort(), ["dev", "web"], "sin sidecar postgres");
  assert.ok(!podSpec.volumes.some((v: any) => v.name === "pgdata"), "sin volumen pgdata");
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  assert.ok(!dev.env.some((e: any) => e.name === "DATABASE_URL"), "sin DATABASE_URL");
  const web = podSpec.containers.find((c: any) => c.name === "web");
  assert.equal(web.readinessProbe.httpGet.path, "/");
  const cm = porKind(ms, "ConfigMap") as any;
  assert.ok(!cm.data.Caddyfile.includes(":3000"), "caddy no apunta al backend");
});

test("manifiestosPreview: default (sin forma) = receta histórica intacta", () => {
  const ms = manifiestosPreview({ app: "mishi-bank", rama: "main", repoUrl: "https://x/y.git", leaseId: "l1" });
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  assert.deepEqual(podSpec.containers.map((c: any) => c.name).sort(), ["dev", "postgres", "web"]);
  const web = podSpec.containers.find((c: any) => c.name === "web");
  assert.equal(web.readinessProbe.httpGet.path, "/");
  const cm = porKind(ms, "ConfigMap") as any;
  assert.ok("vite.dev.mke.config.ts" in cm.data);
  assert.match(cm.data.Caddyfile, /handle \/api\/\*/);
});

test("manifiestosPreview: sin backend NI frontend revienta claro; --live sin frontend revienta", () => {
  assert.throws(() => manifiestosPreview({ app: "x", rama: "m", repoUrl: "u", leaseId: "l", backend: false, frontend: false }), /nada que encender/);
  assert.throws(() => manifiestosPreview({ app: "x", rama: "m", repoUrl: "u", leaseId: "l", frontend: false, live: true }), /--live.*frontend/);
});

test("manifiestosPreview: imagen alternativa del runner llega a init y dev", () => {
  const ms = manifiestosPreview({ app: "chrome-mishi", rama: "perfiles", repoUrl: "u", leaseId: "l", frontend: false, imagen: "mke-chrome-runner:1" });
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  assert.equal(podSpec.initContainers[0].image, "mke-chrome-runner:1");
  assert.equal(podSpec.containers.find((c: any) => c.name === "dev").image, "mke-chrome-runner:1");
});
