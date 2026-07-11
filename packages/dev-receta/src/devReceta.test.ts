import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugDev,
  devName,
  devHost,
  devServicioInterno,
  selectorDeDev,
  devLiveBase,
  viteDevConfig,
  manifiestosDev,
  parseDotEnv,
  mergeDevEnv,
  clavesViteTokenProhibidas,
  DEV_VITE_PORT,
  featureName,
  featureHost,
  selectorDeFeature,
  manifiestosFeature,
  FEATURE_NAMESPACE,
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

test("manifiestosDev: modo EMBED (--live) → vite base, redirect de raíz y annotation", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git", live: true });
  const cm = porKind(ms, "ConfigMap") as any;
  // vite sirve bajo /live/mishi-bank/
  assert.match(cm.data["vite.dev.mke.config.ts"], /base: "\/live\/mishi-bank\/"/);
  // caddy redirige SOLO la raíz exacta a la base; el resto sigue yendo a vite
  assert.match(cm.data.Caddyfile, /handle \/ \{/, "redirect solo de la raíz exacta");
  assert.match(cm.data.Caddyfile, /redir \/live\/mishi-bank\/ 302/, "redir a la base live");
  assert.match(cm.data.Caddyfile, /reverse_proxy 127\.0\.0\.1:5173/, "el resto a vite");
  // NO duplicamos el proxy de la app (^/live/[^/]+/api → backend): eso es del app
  assert.ok(!/live.*api/.test(cm.data.Caddyfile), "caddy no maneja /live/<app>/api");
  // annotation para que Studio lo derive
  const ann = (porKind(ms, "Deployment").metadata as any).annotations;
  assert.equal(ann["mke.dev/live"], "true");
});

test("manifiestosDev: sin --live NO hay base, ni redirect, ni annotation live", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const cm = porKind(ms, "ConfigMap") as any;
  assert.ok(!/\bbase:/.test(cm.data["vite.dev.mke.config.ts"]), "sin base");
  assert.ok(!/redir /.test(cm.data.Caddyfile), "sin redirect");
  const ann = (porKind(ms, "Deployment").metadata as any).annotations;
  assert.ok(!("mke.dev/live" in ann), "sin annotation live");
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

test("manifiestosDev: ConfigMap trae cargar-dev-env.sh; boot y rama lo sourcean", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const cm = porKind(ms, "ConfigMap") as any;
  assert.ok(cm.data["cargar-dev-env.sh"], "ConfigMap trae el loader de dev.env");
  // el loader lee k8s/dev.env y solo exporta si la clave NO está ya en el entorno
  // (así --env del CLI, ya en el entorno por el Secret, GANA sobre el archivo)
  assert.match(cm.data["cargar-dev-env.sh"], /k8s\/dev\.env/, "lee k8s/dev.env de la app");
  assert.match(cm.data["cargar-dev-env.sh"], /printenv "\$clave"/, "no pisa lo ya presente (--env gana)");
  // boot-dev.sh y rama.sh sourcean el loader
  for (const s of ["boot-dev.sh", "rama.sh"]) {
    assert.match(cm.data[s], /\. \/mke\/cargar-dev-env\.sh/, `${s} sourcea la config de la app`);
  }
  // cambiar de rama pide reinicio de la app para adoptar la nueva dev.env
  assert.match(cm.data["rama.sh"], /\/workspace\/\.dev\/restart/, "rama.sh dispara el reinicio");
  assert.match(cm.data["boot-dev.sh"], /\/workspace\/\.dev\/restart/, "boot supervisa el sentinel");
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
  assert.deepEqual(dev.command, ["sh", "/mke/boot-dev.sh"]);
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

test("manifiestosDev: NINGÚN mountPath bajo /dev (pisa el fs de dispositivos: runc revienta con Init:RunContainerError)", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  const contenedores = [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])];
  for (const c of contenedores) {
    for (const vm of c.volumeMounts ?? []) {
      assert.ok(
        vm.mountPath !== "/dev" && !String(vm.mountPath).startsWith("/dev/"),
        `${c.name} monta en ${vm.mountPath} (prohibido /dev)`,
      );
    }
  }
  // los scripts viven en /mke
  const dev = contenedores.find((c: any) => c.name === "dev");
  assert.ok(dev.volumeMounts.some((v: any) => v.mountPath === "/mke"), "scripts en /mke");
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
  for (const f of ["prepare.sh", "build-packages.sh", "cargar-dev-env.sh", "boot-dev.sh", "reset-db.sh", "rama.sh", "pull.sh", "poll.sh", "vite.dev.mke.config.ts", "Caddyfile"]) {
    assert.ok(cm.data[f], `ConfigMap trae ${f}`);
  }
  // caddy proxya /api, /health y /dev (contrato de escena) al backend y todo lo
  // demás a vite (websockets/HMR)
  assert.match(cm.data.Caddyfile, /handle \/api\/\*/, "caddy: /api al backend");
  assert.match(cm.data.Caddyfile, /handle \/dev\/\*/, "caddy: /dev (escena) al backend");
  assert.match(cm.data.Caddyfile, /reverse_proxy 127\.0\.0\.1:5173/, "caddy: resto a vite");
});

test("manifiestosDev: los packages del workspace se construyen tras install/checkout/pull", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const cm = porKind(ms, "ConfigMap") as any;
  // build de packages: loop sobre packages/*/package.json con --if-present (NO
  // el build completo del repo, que incluiría el frontend y es lento)
  assert.match(cm.data["build-packages.sh"], /packages\/\*\/package\.json/, "loop sobre packages/*");
  assert.match(cm.data["build-packages.sh"], /--if-present/, "tolera packages sin build");
  for (const script of ["prepare.sh", "rama.sh", "pull.sh"]) {
    assert.match(cm.data[script], /sh \/mke\/build-packages\.sh/, `${script} construye los packages`);
  }
  // backend y vite corren en un supervisor que reinicia con backoff si mueren en
  // el boot (tsx watch no revive un crash si no cambian archivos)
  assert.match(cm.data["boot-dev.sh"], /murió \(intento/, "loop de reinicio con backoff");
  assert.match(cm.data["boot-dev.sh"], /sleep "\$espera"/, "backoff entre reintentos");
  assert.match(cm.data["boot-dev.sh"], /supervisar backend /, "supervisor del backend");
});

test("manifiestosDev: envExtra va en un Secret <name>-env + envFrom en dev Y preparar, nunca en claro", () => {
  const ms = manifiestosDev({
    app: "mishi-bank",
    repoUrl: "https://x/y.git",
    pollSeconds: 20,
    seedCmd: "npm run seed -w apps/backend",
    envExtra: { NODE_AUTH_TOKEN: "ghp_secreto", CONNECT_URL: "http://connect.dev.svc" },
  });
  // Secret propio con los valores en base64
  const envSecret = ms.find(
    (m) => m.kind === "Secret" && (m.metadata as any).name === "mishi-bank-dev-env",
  ) as any;
  assert.ok(envSecret, "Secret <name>-env presente");
  assert.equal(Buffer.from(envSecret.data.NODE_AUTH_TOKEN, "base64").toString("utf8"), "ghp_secreto");
  assert.equal(Buffer.from(envSecret.data.CONNECT_URL, "base64").toString("utf8"), "http://connect.dev.svc");
  assert.equal(envSecret.metadata.labels["mke.dev/name"], "mishi-bank-dev", "label de borrado");

  // envFrom en el contenedor dev Y en el init preparar (npm install del init
  // puede necesitar p.ej. NODE_AUTH_TOKEN para GitHub Packages)
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  const preparar = podSpec.initContainers.find((c: any) => c.name === "preparar");
  for (const c of [dev, preparar]) {
    assert.deepEqual(c.envFrom, [{ secretRef: { name: "mishi-bank-dev-env" } }], `${c.name} con envFrom`);
  }

  // los VALORES jamás en claro en el Deployment (solo en el Secret, base64)
  const deployment = porKind(ms, "Deployment");
  assert.ok(!JSON.stringify(deployment).includes("ghp_secreto"), "token no va en claro");

  // seedCmd/poll siguen como env explícito de la receta
  const val = (n: string) => dev.env.find((e: any) => e.name === n)?.value;
  assert.equal(val("SEED_CMD"), "npm run seed -w apps/backend");
  assert.equal(val("POLL_SECONDS"), "20");
});

test("manifiestosDev: sin envExtra NO hay Secret <name>-env ni envFrom", () => {
  const ms = manifiestosDev({ app: "polla", repoUrl: "https://x/y.git" });
  assert.ok(
    !ms.some((m) => m.kind === "Secret" && String((m.metadata as any).name).endsWith("-env")),
    "sin Secret -env",
  );
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  for (const c of [...podSpec.initContainers, ...podSpec.containers]) {
    assert.equal(c.envFrom, undefined, `${c.name} sin envFrom`);
  }
});

test("manifiestosDev: npmToken → Secret <name>-npm + env NODE_AUTH_TOKEN en preparar Y dev, nunca en claro", () => {
  const ms = manifiestosDev({
    app: "mishi-bank",
    repoUrl: "https://x/y.git",
    npmToken: "ghp_packages_secreto",
  });
  // Secret propio con el token base64
  const npmSecret = ms.find(
    (m) => m.kind === "Secret" && (m.metadata as any).name === "mishi-bank-dev-npm",
  ) as any;
  assert.ok(npmSecret, "Secret <name>-npm presente");
  assert.equal(
    Buffer.from(npmSecret.data.NODE_AUTH_TOKEN, "base64").toString("utf8"),
    "ghp_packages_secreto",
  );
  assert.equal(npmSecret.metadata.labels["mke.dev/name"], "mishi-bank-dev", "label de borrado");

  // env por secretKeyRef en el init preparar (npm install del clone) Y en dev
  // (rama.sh corre npm install al cambiar de rama)
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  const preparar = podSpec.initContainers.find((c: any) => c.name === "preparar");
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  for (const c of [preparar, dev]) {
    const e = c.env.find((x: any) => x.name === "NODE_AUTH_TOKEN");
    assert.ok(e, `${c.name} lleva NODE_AUTH_TOKEN`);
    assert.deepEqual(
      e.valueFrom,
      { secretKeyRef: { name: "mishi-bank-dev-npm", key: "NODE_AUTH_TOKEN" } },
      `${c.name} lo toma del Secret, no en claro`,
    );
  }

  // el token jamás en claro en el Deployment
  assert.ok(!JSON.stringify(porKind(ms, "Deployment")).includes("ghp_packages_secreto"));
});

test("manifiestosDev: sin npmToken NO hay Secret <name>-npm ni env NODE_AUTH_TOKEN", () => {
  const ms = manifiestosDev({ app: "polla", repoUrl: "https://x/y.git" });
  assert.ok(
    !ms.some((m) => m.kind === "Secret" && String((m.metadata as any).name).endsWith("-npm")),
    "sin Secret -npm",
  );
  const podSpec = (porKind(ms, "Deployment").spec as any).template.spec;
  for (const c of [...podSpec.initContainers, ...podSpec.containers]) {
    assert.ok(
      !(c.env ?? []).some((e: any) => e.name === "NODE_AUTH_TOKEN"),
      `${c.name} sin NODE_AUTH_TOKEN`,
    );
  }
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

test("manifiestosDev: cargar-dev-env.sh CANDADO — aborta ruidoso si dev.env trae VITE_*TOKEN*", () => {
  const ms = manifiestosDev({ app: "mishi-bank", repoUrl: "https://x/y.git" });
  const cm = porKind(ms, "ConfigMap") as any;
  const script = cm.data["cargar-dev-env.sh"];
  assert.match(script, /VITE_\*TOKEN\*/, "detecta el patrón VITE_*TOKEN*");
  assert.match(script, /exit 1/, "aborta el boot, no carga en silencio");
  assert.match(script, /CANDADO/, "mensaje explícito de por qué aborta");
});

test("manifiestosDev: annotations vivos rama/sha en el Deployment", () => {
  const ms = manifiestosDev({ app: "mishi-bank", rama: "feat/x", repoUrl: "https://x/y.git" });
  const ann = (porKind(ms, "Deployment").metadata as any).annotations;
  assert.equal(ann["mke.dev/rama"], "feat/x");
  assert.ok("mke.dev/sha" in ann, "annotation de sha presente (la llena el CLI)");
});

// ─── feature-pod (`mke feature`) ─────────────────────────────────────────────

test("featureName/featureHost: nombre y host llevan la RAMA (no --nombre opcional)", () => {
  assert.equal(featureName("mishi-bank", "feat/cobros"), "mishi-bank-feat-cobros");
  assert.equal(featureHost("mishi-bank", "feat/cobros"), "mishi-bank-feat-cobros-feat.mishi.com.co");
  assert.ok(featureHost("polla", "main").endsWith("-feat.mishi.com.co"));
});

test("selectorDeFeature: label selector app+rama sanitizada", () => {
  assert.equal(selectorDeFeature("mishi-bank", "Feat/Cobros"), "mke.feature/app=mishi-bank,mke.feature/rama=feat-cobros");
});

test("manifiestosFeature: recursos esperados, ns feature propio, nombre y host con rama", () => {
  const ms = manifiestosFeature({
    app: "mishi-bank",
    rama: "feat/cobros",
    repoUrl: "https://github.com/mishicomco/mishi-bank.git",
    leaseId: "lease-1",
    leaseToken: "token-secreto",
  });
  assert.deepEqual(
    ms.map((m) => m.kind),
    ["Namespace", "Secret", "Secret", "ConfigMap", "Deployment", "Service", "Ingress"],
  );
  assert.equal((ms.find((m) => m.kind === "Namespace")!.metadata as any).name, FEATURE_NAMESPACE);
  const dep = ms.find((m) => m.kind === "Deployment")!;
  assert.equal((dep.metadata as any).name, featureName("mishi-bank", "feat/cobros"));
  const ing = ms.find((m) => m.kind === "Ingress")!;
  assert.equal((ing.spec as any).rules[0].host, featureHost("mishi-bank", "feat/cobros"));
});

test("manifiestosFeature: TODO objeto del bundle lleva mke.feature/app|rama|lease (Contrato 1)", () => {
  const ms = manifiestosFeature({
    app: "mishi-bank",
    rama: "feat/cobros",
    repoUrl: "https://x/y.git",
    leaseId: "lease-abc123",
    leaseToken: "token-secreto",
  });
  // el Namespace es COMPARTIDO por todos los feature-pods (no es del bundle de
  // uno solo); el resto del bundle SÍ lleva los 3 labels (Contrato 1).
  for (const m of ms.filter((x) => x.kind !== "Namespace")) {
    const labels = (m.metadata as any).labels ?? {};
    assert.equal(labels["mke.feature/app"], "mishi-bank", `${m.kind} label app`);
    assert.equal(labels["mke.feature/rama"], "feat-cobros", `${m.kind} label rama (sanitizada)`);
    assert.equal(labels["mke.feature/lease"], "lease-abc123", `${m.kind} label lease`);
  }
});

test("manifiestosFeature: el leaseToken va en un Secret propio + env LEASE_TOKEN, nunca en claro", () => {
  const ms = manifiestosFeature({
    app: "mishi-bank",
    rama: "main",
    repoUrl: "https://x/y.git",
    leaseId: "lease-1",
    leaseToken: "super-secreto-del-vault",
  });
  const leaseSecret = ms.find(
    (m) => m.kind === "Secret" && (m.metadata as any).name === `${featureName("mishi-bank", "main")}-lease`,
  ) as any;
  assert.ok(leaseSecret, "Secret <name>-lease presente");
  assert.equal(Buffer.from(leaseSecret.data.LEASE_TOKEN, "base64").toString("utf8"), "super-secreto-del-vault");

  const podSpec = (ms.find((m) => m.kind === "Deployment")!.spec as any).template.spec;
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  const e = dev.env.find((x: any) => x.name === "LEASE_TOKEN");
  assert.ok(e, "el contenedor dev lleva LEASE_TOKEN");
  assert.deepEqual(e.valueFrom, {
    secretKeyRef: { name: `${featureName("mishi-bank", "main")}-lease`, key: "LEASE_TOKEN" },
  });
  assert.ok(!JSON.stringify(ms.find((m) => m.kind === "Deployment")).includes("super-secreto-del-vault"));
});

test("manifiestosFeature: `config` (Contrato 2) va DIRECTO al env del pod, en claro; CERO envExtra/--env", () => {
  const ms = manifiestosFeature({
    app: "mishi-bank",
    rama: "main",
    repoUrl: "https://x/y.git",
    leaseId: "lease-1",
    leaseToken: "t",
    config: {
      IDENTITY_URL: "http://identity-preview.dev.svc:3000",
      IDENTITY_JWKS_URL: "http://identity-preview.dev.svc:3000/v1/llaves",
    },
  });
  const podSpec = (ms.find((m) => m.kind === "Deployment")!.spec as any).template.spec;
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  const val = (n: string) => dev.env.find((e: any) => e.name === n)?.value;
  assert.equal(val("IDENTITY_URL"), "http://identity-preview.dev.svc:3000");
  assert.equal(val("IDENTITY_JWKS_URL"), "http://identity-preview.dev.svc:3000/v1/llaves");
  // no hay envFrom (el mecanismo --env/Secret-env de `mke dev` está MUERTO acá)
  for (const c of [...podSpec.initContainers, ...podSpec.containers]) {
    assert.equal(c.envFrom, undefined, `${c.name} sin envFrom (CERO --env humano)`);
  }
});

test("manifiestosFeature: sin `config` no revienta (solo los env base de la receta)", () => {
  const ms = manifiestosFeature({
    app: "polla",
    rama: "main",
    repoUrl: "https://x/y.git",
    leaseId: "lease-1",
    leaseToken: "t",
  });
  const podSpec = (ms.find((m) => m.kind === "Deployment")!.spec as any).template.spec;
  const dev = podSpec.containers.find((c: any) => c.name === "dev");
  assert.ok(dev.env.some((e: any) => e.name === "PREVIEW" && e.value === "true"));
});

test("manifiestosFeature: npmToken opcional igual que en manifiestosDev", () => {
  const ms = manifiestosFeature({
    app: "mishi-bank",
    rama: "main",
    repoUrl: "https://x/y.git",
    leaseId: "lease-1",
    leaseToken: "t",
    npmToken: "ghp_x",
  });
  const npmSecret = ms.find(
    (m) => m.kind === "Secret" && (m.metadata as any).name === `${featureName("mishi-bank", "main")}-npm`,
  );
  assert.ok(npmSecret, "Secret <name>-npm presente");
});
