// mke artifact — el tipo de app "artifact": un frontend estandar de Mishi sin
// build y sin ambientes (diseño completo: ../../AI_ARTIFACTS.md).
//
// Idea rectora: un artifact es un REPO DE UN SOLO ARCHIVO con deploy de dos
// segundos. El fuente y su historia viven en el repo `artifacts-mishi` del
// forge (una carpeta por artifact); el HTML servido vive en el PVC de
// static-mishi (`/srv/www/<nombre>-artifact/`), cuyo nginx ya mapea el host por
// regex sin tocarse. El runtime compartido (`mishi.css`/`mishi.js`) se sirve
// desde /srv/www/artifact-runtime via symlink por carpeta — se parcha en UN
// lugar para todos los artifacts.
//
// Seguridad de origen (dia 1): Middleware CSP en Traefik para *-artifact.* —
// un artifact solo habla con su propio origen (la cookie mishi_sesion es de
// dominio .mishi.com.co; sin CSP, un XSS en un artifact seria una cabeza de
// playa contra todo el ecosistema).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { appsRoot, DOMAIN, ENVS } from "./mkeConfig.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";
import { cargarImagenes } from "./cargaImagenes.js";
import { doctor } from "./doctor.js";
import { tunnelTarget, upsertCname, deleteRecordsByName } from "./cf.js";
import { FORGE, forgeCreateRepo, forgeRepoUrl, secretGet } from "./forgeRepo.js";

const execFileAsync = promisify(execFile);

const SUFIJO = "-artifact";
const REPO = "artifacts-mishi";
const RUNTIME_PVC = "/srv/www/artifact-runtime";
const SPEC = ENVS.prod; // un artifact tiene UN solo lugar: ni stage ni prod
// Desde 2026-08-10 la app/guardia/rutas de artifacts viven en su PROPIO ns
// `artifact` (laptop); los ARCHIVOS los sigue sirviendo static-mishi desde su
// PVC en ns prod (el IngressRoute cruza namespaces — allowCrossNamespace).
const NS_ART = "artifact";

const hostDe = (nombre: string) => `${nombre}${SUFIJO}.${DOMAIN}`;
const carpetaPvc = (nombre: string) => `/srv/www/${nombre}${SUFIJO}`;
const cloneDir = () => join(appsRoot(), REPO);
const runtimeSrc = () => join(appsRoot(), "mke", "platform", "artifacts", "runtime");

function validarNombre(nombre: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(nombre)) {
    return "nombre invalido: [a-z0-9-], empieza alfanumerico, max 41 chars";
  }
  if (nombre.endsWith("-artifact")) return "no repitas el sufijo: el host ya lleva -artifact";
  if (nombre.endsWith("-stage") || nombre.endsWith("-local")) {
    return "sufijo reservado por la convencion de subdominios (-stage/-local)";
  }
  return null;
}

/** pod vivo de static-mishi en prod (monta el PVC static-www RW). */
async function podStatic(): Promise<string | null> {
  const r = await run("kubectl", [
    "--context", SPEC.context, "-n", SPEC.namespace,
    "get", "pod", "-l", "app=static-mishi",
    "-o", "jsonpath={.items[0].metadata.name}",
  ]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

async function execEnPod(pod: string, sh: string): Promise<{ code: number; out: string }> {
  const r = await run("kubectl", [
    "--context", SPEC.context, "-n", SPEC.namespace,
    "exec", pod, "--", "sh", "-c", sh,
  ]);
  return { code: r.code, out: r.stdout || r.stderr };
}

// ── git: historia + backup (el fuente NUNCA vive solo en el PVC) ──────────

/** git en el clone local con credenciales del forge por env (nunca argv/logs). */
async function gitForge(args: string[], token: string | null): Promise<{ code: number; out: string }> {
  const base = ["-C", cloneDir()] as string[];
  if (token) {
    base.push("-c", "credential.helper=!f() { echo username=token; echo password=$MKE_FORGE_TOKEN; }; f");
  }
  try {
    const { stdout, stderr } = await execFileAsync("git", [...base, ...args], {
      env: { ...process.env, ...(token ? { MKE_FORGE_TOKEN: token } : {}) },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: (stdout + stderr).trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      out: (e.stderr ?? e.stdout ?? e.message ?? "").trim(),
    };
  }
}

/**
 * Asegura el repo local `artifacts-mishi` (git init si falta) y, best-effort,
 * su remoto primario en el forge. La historia LOCAL esta garantizada siempre;
 * el push es resiliente (forge caido = WARN, no bloquea publicar).
 */
async function asegurarRepo(token: string | null): Promise<void> {
  const dir = cloneDir();
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    await gitForge(["init", "-b", "main"], null);
    writeFileSync(
      join(dir, "README.md"),
      `# ${REPO}\n\nFuente e historia de los artifacts (\`mke artifact\`). Una carpeta por artifact.\nEl diseño vive en \`mke/AI_ARTIFACTS.md\`; esto NO es una app: no tiene CI ni deploy —\npublicar es \`mke artifact publicar\`, que commitea aca y copia al PVC de static-mishi.\n`,
    );
    await gitForge(["add", "-A"], null);
    await gitForge(["commit", "-m", "nace artifacts-mishi"], null);
  }
  if (token) {
    try {
      await forgeCreateRepo(REPO, token); // idempotente
    } catch (e) {
      console.log(warn(`no pude asegurar el repo en el forge: ${(e as Error).message}`));
    }
    const remotos = await gitForge(["remote"], null);
    if (!remotos.out.split("\n").includes("origin")) {
      await gitForge(["remote", "add", "origin", forgeRepoUrl(REPO)], null);
    }
  }
}

/** commit de la carpeta del artifact + push best-effort. */
async function archivar(nombre: string, mensaje: string): Promise<void> {
  const token = await secretGet(FORGE.apiTokenSecret);
  await asegurarRepo(token);
  await gitForge(["add", "-A", nombre], null);
  const commit = await gitForge(["commit", "-m", mensaje], null);
  if (commit.code === 0) {
    console.log(ok(`historia: ${dim(mensaje)} (${REPO})`));
  } else if (/nothing to commit|nada para hacer commit/i.test(commit.out)) {
    console.log(info("historia: sin cambios respecto a la ultima publicacion"));
  } else {
    console.log(warn(`commit fallo: ${commit.out}`));
  }
  if (token) {
    const push = await gitForge(["push", "-u", "origin", "main"], token);
    if (push.code === 0) console.log(ok("backup: push al forge"));
    else console.log(warn(`push al forge fallo (la historia local queda): ${push.out.slice(0, 200)}`));
  } else {
    console.log(warn("sin token del forge (git-mishi-api-token): historia solo local"));
  }
}

// ── routing de plataforma (idempotente, se aplica en cada publicar) ───────

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const GUARDIA = "artifact-guardia";
const GUARDIA_IMG = `${GUARDIA}:dev`;
// Autorizacion de los artifacts: el DUEÑO de la verdad es la tabla `accesos`
// de artifact-mishi (`mke artifact acceso`), no esta lista. Lo que queda aqui
// es el RESPALDO ANTI-LOCKOUT que la guardia usa SOLO si artifact-mishi no
// responde — por eso conserva los emails que tenian acceso cuando la allowlist
// era la unica verdad (2026-08-08). No crece: dar acceso = `mke artifact acceso`.
const GUARDIA_PERMITIDOS = [
  "santiramirezc@gmail.com",
  "q1.26.mateo@gmail.com", // cuenta IA dedicada: verifica lo que publica (OK Santi 2026-08-07)
];
const guardiaDir = () => join(appsRoot(), "mke", "platform", "artifacts", "guardia");

/**
 * La puerta de los artifacts (PRIVADOS por defecto): micro-servicio que valida
 * `mishi_sesion` contra el JWKS del IdP (prod Y stage) y sin sesion redirige
 * al login alojado. Se construye/deploya solo si falta; `mke artifact guardia`
 * fuerza rebuild (p.ej. tras editar server.mjs).
 */
export async function guardiaDeploy(forzar = false): Promise<boolean> {
  if (!forzar) {
    const hay = await run("kubectl", [
      "--context", SPEC.context, "-n", NS_ART,
      "get", "deploy", GUARDIA, "-o", "name",
    ]);
    if (hay.code === 0) return true;
  }
  console.log(info(`build ${dim(GUARDIA_IMG)} (la puerta de los artifacts)`));
  const build = await run("docker", ["build", "-t", GUARDIA_IMG, guardiaDir()]);
  if (build.code !== 0) {
    console.log(bad(`docker build del guardia fallo: ${build.stderr || build.stdout}`));
    return false;
  }
  const imp = await cargarImagenes(SPEC, [GUARDIA_IMG]);
  if (imp.code !== 0) {
    console.log(bad(`carga de imagen del guardia fallo: ${imp.stderr || imp.stdout}`));
    return false;
  }
  const manifiestos = [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: GUARDIA,
        namespace: NS_ART,
        labels: { "app.kubernetes.io/part-of": "mke" },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: GUARDIA } },
        template: {
          metadata: { labels: { app: GUARDIA } },
          spec: {
            containers: [
              {
                name: GUARDIA,
                image: GUARDIA_IMG,
                imagePullPolicy: "IfNotPresent",
                env: [
                  { name: "ALLOWED_EMAILS", value: GUARDIA_PERMITIDOS.join(",") },
                  // Un host, un veredicto (ley 2026-08-11): los artifacts son
                  // PROD y su backend valida solo prod — la guardia igual. Con
                  // el JWKS de stage aquí, una cookie de stage VEÍA la página
                  // pero la app la negaba (estado fantasma) y un humano
                  // terminaba recibiendo instrucciones de cookies. Cookie de
                  // stage ahora = como sin cookie → 302 al IdP de prod, que
                  // re-emite solo (auto_select) y devuelve.
                  { name: "IDPS", value: "https://identity.mishi.com.co" },
                ],
                ports: [{ containerPort: 3000 }],
                readinessProbe: { httpGet: { path: "/readyz", port: 3000 } },
                resources: {
                  requests: { cpu: "10m", memory: "32Mi" },
                  limits: { cpu: "200m", memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: GUARDIA,
        namespace: NS_ART,
        labels: { "app.kubernetes.io/part-of": "mke" },
      },
      spec: { selector: { app: GUARDIA }, ports: [{ port: 80, targetPort: 3000 }] },
    },
  ];
  const tmp = join(tmpdir(), `mke-guardia-${Date.now().toString(36)}.json`);
  try {
    writeFileSync(tmp, manifiestos.map((m) => JSON.stringify(m)).join("\n"));
    const r = await run("kubectl", ["--context", SPEC.context, "apply", "-f", tmp]);
    if (r.code !== 0) {
      console.log(bad(`apply del guardia fallo: ${r.stderr || r.stdout}`));
      return false;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  if (forzar) {
    await run("kubectl", ["--context", SPEC.context, "-n", NS_ART, "rollout", "restart", `deploy/${GUARDIA}`]);
  }
  const listo = await run("kubectl", [
    "--context", SPEC.context, "-n", NS_ART,
    "rollout", "status", `deploy/${GUARDIA}`, "--timeout=90s",
  ]);
  if (listo.code !== 0) {
    console.log(bad(`el guardia no quedo Ready: ${listo.stderr || listo.stdout}`));
    return false;
  }
  console.log(ok("artifact-guardia desplegado (la puerta de los artifacts)"));
  return true;
}

/**
 * Middleware CSP + ForwardAuth (guardia) + IngressRoute HostRegexp, en el ns
 * prod. Dos reglas: /_mishi/* va al guardia SIN puerta (sesion/salir para la
 * barra); todo lo demas pasa por la puerta y llega a static-mishi. Traefik
 * prioriza por longitud de regla: /_mishi gana; la futura /api de Fase 2
 * tambien ganara. Ningun host real termina en -artifact (sufijo reservado).
 */
async function asegurarRouting(): Promise<boolean> {
  const svcGuardia = `http://${GUARDIA}.${NS_ART}.svc.cluster.local/guardia`;
  const manifiestos = [
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: {
        name: "artifact-auth",
        namespace: NS_ART,
        labels: { "app.kubernetes.io/part-of": "mke" },
      },
      spec: { forwardAuth: { address: svcGuardia } },
    },
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: {
        name: "artifact-csp",
        namespace: NS_ART,
        labels: { "app.kubernetes.io/part-of": "mke" },
      },
      spec: {
        headers: {
          contentSecurityPolicy: CSP,
          // Cloudflare cachea .js/.css 4 h por defecto: iterar un artifact
          // servia archivos VIEJOS desde el edge. no-cache (CF lo respeta)
          // = sin cache de edge/navegador; nginx revalida por etag (304).
          customResponseHeaders: { "Cache-Control": "no-cache" },
        },
      },
    },
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: "artifacts",
        namespace: NS_ART,
        labels: { "app.kubernetes.io/part-of": "mke" },
      },
      spec: {
        routes: [
          {
            // la barra pregunta quien esta adentro / cierra sesion: va al
            // guardia DIRECTO (sin puerta — responder "no autenticado" es
            // precisamente su trabajo). Regla mas larga: gana.
            match: "HostRegexp(`^[a-z0-9-]+-artifact\\.mishi\\.com\\.co$`) && PathPrefix(`/_mishi`)",
            kind: "Rule",
            services: [{ name: GUARDIA, port: 80, namespace: NS_ART }],
          },
          {
            // Fase 2: /api de todo artifact va a artifact-mishi (la capa de
            // datos de plataforma). Regla mas larga que la general: gana.
            // Pasa por la puerta igual que el contenido (privados por defecto).
            // ns PROD, no NS_ART (drift de la fusión 2026-08-10): el deployment
            // canónico es el del pipeline (`mke deploy` → ns prod, el mismo que
            // usa la guardia); el clon en ns artifact quedó huérfano con la BD
            // caída y las escrituras de artifacts rotas 38h.
            match: "HostRegexp(`^[a-z0-9-]+-artifact\\.mishi\\.com\\.co$`) && PathPrefix(`/api`)",
            kind: "Rule",
            middlewares: [{ name: "artifact-auth", namespace: NS_ART }],
            services: [{ name: "artifact-mishi", port: 80, namespace: "prod" }],
          },
          {
            match: "HostRegexp(`^[a-z0-9-]+-artifact\\.mishi\\.com\\.co$`)",
            kind: "Rule",
            middlewares: [
              { name: "artifact-auth", namespace: NS_ART },
              { name: "artifact-csp", namespace: NS_ART },
            ],
            services: [{ name: "static-mishi", port: 80, namespace: SPEC.namespace }],
          },
        ],
      },
    },
  ];
  const tmp = join(tmpdir(), `mke-artifact-routing-${Date.now().toString(36)}.json`);
  try {
    writeFileSync(tmp, manifiestos.map((m) => JSON.stringify(m)).join("\n"));
    const r = await run("kubectl", ["--context", SPEC.context, "apply", "-f", tmp]);
    if (r.code !== 0) {
      console.log(bad(`routing (IngressRoute+CSP) fallo: ${r.stderr || r.stdout}`));
      return false;
    }
    console.log(ok(`routing artifacts + CSP ${dim("(idempotente)")}`));
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** sincroniza el runtime compartido (fuente: mke/platform/artifacts/runtime). */
async function sincronizarRuntime(pod: string): Promise<boolean> {
  const src = runtimeSrc();
  if (!existsSync(src)) {
    console.log(bad(`no encuentro el runtime en ${src}`));
    return false;
  }
  // republicacion rapida: si el hash del runtime local == el del PVC, no hay
  // nada que sincronizar
  const hash = await hashRuntime();
  const enPvc = await execEnPod(pod, `cat ${RUNTIME_PVC}/.hash 2>/dev/null || true`);
  if (enPvc.out.trim() === hash) {
    console.log(ok(`runtime compartido al dia ${dim(`(${hash})`)}`));
    return true;
  }
  await execEnPod(pod, `rm -rf ${RUNTIME_PVC} && mkdir -p ${RUNTIME_PVC}`);
  const cp = await run("kubectl", [
    "--context", SPEC.context, "-n", SPEC.namespace,
    "cp", `${src}/.`, `${pod}:${RUNTIME_PVC}`,
  ]);
  if (cp.code !== 0) {
    console.log(bad(`cp del runtime fallo: ${cp.stderr || cp.stdout}`));
    return false;
  }
  await execEnPod(pod, `printf '%s' '${hash}' > ${RUNTIME_PVC}/.hash`);
  console.log(ok(`runtime compartido sincronizado ${dim(RUNTIME_PVC)}`));
  return true;
}

// ── verbos ────────────────────────────────────────────────────────────────

export interface ArtifactPublicarOpts {
  /** no commitear (lo usa rollback, que ya hizo su commit) */
  sinArchivar?: boolean;
  /** mensaje de commit (-m); default "publicar <nombre> (<origen>)" */
  mensaje?: string;
}

/** hash del contenido del runtime local (para saltar el sync si no cambió). */
async function hashRuntime(): Promise<string> {
  const r = await run("sh", [
    "-c",
    `find ${runtimeSrc()} -type f | sort | xargs cat | sha256sum | cut -c1-16`,
  ]);
  return r.code === 0 ? r.stdout.trim() : Date.now().toString(36);
}

/**
 * Publica un artifact: archiva el fuente (git), asegura CNAME + routing + CSP,
 * copia al PVC con symlink al runtime compartido, y verifica la cadena publica.
 * Idempotente: republicar = sobrescribir (con la version anterior en git).
 */
export async function artifactPublicar(
  nombre: string,
  origen: string,
  opts: ArtifactPublicarOpts = {},
): Promise<boolean> {
  const invalido = validarNombre(nombre);
  if (invalido) {
    console.log(bad(invalido));
    return false;
  }
  if (!existsSync(origen)) {
    console.log(bad(`no existe: ${origen}`));
    return false;
  }
  const esDir = !origen.endsWith(".html");
  if (esDir && !existsSync(join(origen, "index.html"))) {
    console.log(bad(`la carpeta no tiene index.html: ${origen}`));
    return false;
  }
  const host = hostDe(nombre);
  console.log(info(`publicando ${dim(nombre)} → https://${host}`));

  // 1) DNS PRIMERO (un CNAME por artifact): es el único paso con latencia de
  // propagación (hostname→túnel por los POPs de CF), así que arranca YA y
  // propaga en paralelo con git+guardia+runtime+cp. SIEMPRE por la API de CF:
  // "el host resuelve" NO prueba nada — hay un comodín en la zona y TODO
  // subdominio resuelve (bache real: el atajo por getent dejó un artifact
  // nuevo colgado del destino del comodín, 530 hasta un `mke dns` manual).
  let dnsRecienCreado = false;
  try {
    const dns = await upsertCname(host, tunnelTarget(SPEC.tunnelUuid));
    dnsRecienCreado = dns === "creado";
    console.log(ok(`DNS ${dns}: ${host}`));
  } catch (e) {
    console.log(bad(`DNS fallo: ${(e as Error).message}`));
    return false;
  }

  // 2) fuente e historia (git) — el PVC nunca es el unico ejemplar.
  // `nacer` deja el cascaron EXACTAMENTE en cloneDir()/<nombre>: publicar
  // desde ahi es el flujo natural y NO copia sobre si mismo (antes el rmSync
  // previo BORRABA el trabajo — bache destructivo real de un agente).
  if (!opts.sinArchivar) {
    const destRepo = join(cloneDir(), nombre);
    const token = await secretGet(FORGE.apiTokenSecret);
    await asegurarRepo(token);
    const enSitio = resolve(origen) === resolve(destRepo);
    if (!enSitio) {
      rmSync(destRepo, { recursive: true, force: true });
      mkdirSync(destRepo, { recursive: true });
      if (esDir) cpSync(origen, destRepo, { recursive: true });
      else cpSync(origen, join(destRepo, "index.html"));
    }
    await archivar(nombre, opts.mensaje ?? `publicar ${nombre} (${basename(origen)})`);
  }


  // 3) puerta (privados por defecto) + routing + CSP (idempotentes)
  if (!(await guardiaDeploy())) return false;
  if (!(await asegurarRouting())) return false;

  // 4) contenido al PVC + runtime compartido
  const pod = await podStatic();
  if (!pod) {
    console.log(bad("no encuentro el pod de static-mishi en prod"));
    return false;
  }
  if (!(await sincronizarRuntime(pod))) return false;

  const carpeta = carpetaPvc(nombre);
  const fuente = opts.sinArchivar ? join(cloneDir(), nombre) : origen;
  const staging = esDir || opts.sinArchivar ? fuente : mkdtempSync(join(tmpdir(), "mke-artifact-"));
  if (!esDir && !opts.sinArchivar) cpSync(origen, join(staging, "index.html"));
  try {
    await execEnPod(pod, `rm -rf ${carpeta} && mkdir -p ${carpeta}`);
    const cp = await run("kubectl", [
      "--context", SPEC.context, "-n", SPEC.namespace,
      "cp", `${staging}/.`, `${pod}:${carpeta}`,
    ]);
    if (cp.code !== 0) {
      console.log(bad(`cp al PVC fallo: ${cp.stderr || cp.stdout}`));
      return false;
    }
    // runtime compartido visible bajo el origen del artifact (/runtime/v1/…)
    await execEnPod(pod, `ln -sfn ${RUNTIME_PVC} ${carpeta}/runtime`);
    console.log(ok(`contenido en el PVC ${dim(carpeta)}`));

    // cache-bust automático: Cloudflare (Browser Cache TTL de zona) reescribe
    // el Cache-Control del origen y los navegadores retienen .js/.css 4 h —
    // iterar serviría módulos viejos. Se estampa ?v=<versión de esta
    // publicación> en los refs del index SERVIDO (el fuente en git queda
    // limpio). Refs que ya traen ?query se respetan.
    const version = Date.now().toString(36);
    await execEnPod(
      pod,
      `sed -i -E 's|(src="[^"?]+\\.js)"|\\1?v=${version}"|g; s|(href="[^"?]+\\.css)"|\\1?v=${version}"|g' ${carpeta}/index.html; ` +
        // imports relativos entre módulos ES (convención del cascarón)
        `find ${carpeta} -name '*.js' -exec sed -i -E 's|(from "\\./[^"?]+\\.js)"|\\1?v=${version}"|g' {} +`,
    );

    // manifiesto (Fase 2): si el index declara <script type="application/
    // mishi-esquema">, se registra en artifact-mishi (contrato-como-dato).
    // Best-effort: sin backend desplegado, WARN y sigue (Nivel 0).
    const indexHtml = join(staging, "index.html");
    if (existsSync(indexHtml)) {
      const html = readFileSync(indexHtml, "utf8");
      const esquema = /<script[^>]*type="application\/mishi-esquema"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
      if (esquema) {
        try {
          JSON.parse(esquema); // valida acá; el backend re-valida la forma
          const cuerpo = JSON.stringify({ artifact: nombre, manifiesto: JSON.parse(esquema) }).replace(/'/g, "'\\''");
          const reg = await execEnPod(
            pod,
            `curl -s -m 10 -X POST http://artifact-mishi.${NS_ART}.svc.cluster.local/api/manifiesto ` +
              `-H 'content-type: application/json' -d '${cuerpo}'`,
          );
          if (/"ok":true/.test(reg.out)) console.log(ok("manifiesto registrado en artifact-mishi"));
          else console.log(warn(`manifiesto NO registrado: ${reg.out.slice(0, 160) || "artifact-mishi no responde"}`));
        } catch {
          console.log(warn("el mishi-esquema del index.html no es JSON válido — sin registrar"));
        }
      }
    }

    // recarga en vivo: avisa a la guardia (interno) que hay nueva version;
    // las pestañas abiertas del artifact se recargan solas via SSE
    const aviso = await execEnPod(
      pod,
      `curl -s -X POST http://${GUARDIA}.${NS_ART}.svc.cluster.local/avisar ` +
        `-d '{"host":"${host}","version":"${Date.now().toString(36)}"}'`,
    );
    const avisadas = /"avisadas":(\d+)/.exec(aviso.out)?.[1];
    if (avisadas && avisadas !== "0") {
      console.log(ok(`recarga en vivo: ${avisadas} pestaña(s) avisada(s)`));
    }
  } finally {
    if (!esDir && !opts.sinArchivar) rmSync(staging, { recursive: true, force: true });
  }

  // 5) cadena publica — sin esto el publicar NO es verde. Con CNAME recien
  // creado, Cloudflare tarda ~10-30 s en propagar: reintentar NO es un fallo
  // (antes esto terminaba en un FAIL rojo mentiroso con fix equivocado).
  let diag = await doctor(host);
  for (let i = 0; dnsRecienCreado && !diag.sano && i < 4; i++) {
    console.log(info(`CNAME recien creado, propagando DNS… reintento ${i + 1}/4 en 10 s`));
    await new Promise((r) => setTimeout(r, 10_000));
    diag = await doctor(host);
  }
  return diag.sano;
}

/** lista los artifacts vivos: archivos, tamano, ultima publicacion. */
export async function artifactLs(): Promise<void> {
  const pod = await podStatic();
  if (!pod) {
    console.log(bad("no encuentro el pod de static-mishi en prod"));
    return;
  }
  const r = await execEnPod(
    pod,
    `for d in /srv/www/*${SUFIJO}; do [ -d "$d" ] || continue; ` +
      `n=$(find "$d" -type f | wc -l); s=$(du -sk "$d" | cut -f1); ` +
      `echo "$(basename "$d")|$n|$s"; done`,
  );
  if (!r.out.trim()) {
    console.log(info("no hay artifacts publicados"));
    return;
  }
  console.log(`${"ARTIFACT".padEnd(28)} ${"ARCHIVOS".padStart(8)} ${"KB".padStart(8)}  PUBLICADO`);
  for (const linea of r.out.trim().split("\n")) {
    const [carpeta, n, kb] = linea.split("|");
    const nombre = carpeta.replace(new RegExp(`${SUFIJO}$`), "");
    // fecha de la ultima publicacion segun git (dueño de la verdad), no el
    // mtime del PVC (que cambia con cada sync masivo)
    const log = await gitForge(
      ["log", "-1", "--format=%ad", "--date=format:%Y-%m-%d %H:%M", "--", nombre],
      null,
    );
    const fecha = log.code === 0 && log.out ? log.out : "(sin historia)";
    console.log(`${nombre.padEnd(28)} ${n.padStart(8)} ${kb.padStart(8)}  ${fecha}  ${dim(`https://${hostDe(nombre)}`)}`);
  }
}

/** URL + estado de la cadena publica. */
export async function artifactVer(nombre: string): Promise<void> {
  const host = hostDe(nombre);
  console.log(info(`https://${host}`));
  await doctor(host);
}

/**
 * Vuelve a la version ANTERIOR del artifact (git) y republica. La historia
 * completa vive en artifacts-mishi; esto cubre el "publique roto" inmediato.
 */
export async function artifactRollback(nombre: string): Promise<boolean> {
  const dir = join(cloneDir(), nombre);
  if (!existsSync(dir)) {
    console.log(bad(`no hay historia de '${nombre}' en ${cloneDir()}`));
    return false;
  }
  const log = await gitForge(["log", "--format=%H", "-n", "2", "--", nombre], null);
  const hashes = log.out.split("\n").filter(Boolean);
  if (hashes.length < 2) {
    console.log(bad(`'${nombre}' tiene una sola version publicada: no hay a donde volver`));
    return false;
  }
  const restore = await gitForge(["checkout", hashes[1], "--", nombre], null);
  if (restore.code !== 0) {
    console.log(bad(`git checkout fallo: ${restore.out}`));
    return false;
  }
  await archivar(nombre, `rollback ${nombre} → ${hashes[1].slice(0, 8)}`);
  return artifactPublicar(nombre, dir, { sinArchivar: true });
}

/**
 * Genera el cascarón modular estándar en el clone de artifacts-mishi, listo
 * para editar y publicar. Un cpSync de platform/artifacts/plantilla — la
 * plantilla ES la documentación del cascarón.
 */
export async function artifactNacer(nombre: string): Promise<boolean> {
  const invalido = validarNombre(nombre);
  if (invalido) {
    console.log(bad(invalido));
    return false;
  }
  const destino = join(cloneDir(), nombre);
  if (existsSync(destino)) {
    console.log(bad(`ya existe ${destino} — edítalo y publica, o elige otro nombre`));
    return false;
  }
  const plantilla = join(appsRoot(), "mke", "platform", "artifacts", "plantilla");
  await asegurarRepo(await secretGet(FORGE.apiTokenSecret));
  cpSync(plantilla, destino, { recursive: true });
  // NOMBRE → nombre real en los archivos de texto de la plantilla
  await run("sh", ["-c", `grep -rl NOMBRE ${destino} | xargs -r sed -i 's/NOMBRE/${nombre}/g'`]);
  console.log(ok(`cascarón en ${destino}`));
  // el CNAME se crea YA: la asociación hostname→túnel de Cloudflare tarda
  // ~30 s-2 min en propagar por los POPs, y ese era el único paso lento de la
  // PRIMERA publicación. Propagando mientras editas, publicar llega caliente.
  try {
    const dns = await upsertCname(hostDe(nombre), tunnelTarget(SPEC.tunnelUuid));
    console.log(ok(`DNS ${dns}: ${hostDe(nombre)} ${dim("(propaga mientras editas)")}`));
  } catch (e) {
    console.log(warn(`DNS no pre-creado (${(e as Error).message}); publicar lo hará`));
  }
  console.log(info(`edita y publica:  mke artifact publicar ${nombre} ${destino}`));
  return true;
}

/**
 * Da o quita acceso a VER un artifact. La verdad vive en la tabla `accesos` de
 * artifact-mishi; este verbo habla con su endpoint interno igual que el
 * registro del manifiesto: curl DESDE el pod de static-mishi (el endpoint
 * rechaza todo lo que venga por Traefik, X-Forwarded-Host presente).
 *
 * `--todos` = artifact '*' (todos los artifacts). El sujeto es un email o
 * `rol:<rol>` (rol por-app de la tabla usuarios de artifact-mishi).
 */
export async function artifactAcceso(
  artifact: string,
  sujeto: string,
  opciones: { quitar?: boolean } = {},
): Promise<boolean> {
  if (artifact !== "*") {
    const invalido = validarNombre(artifact);
    if (invalido) {
      console.log(bad(invalido));
      return false;
    }
  }
  const pod = await podStatic();
  if (!pod) {
    console.log(bad("no encuentro el pod de static-mishi (es el telefono interno del cluster)"));
    return false;
  }
  const cuerpo = JSON.stringify({
    artifact,
    sujeto: sujeto.trim().toLowerCase(),
    quitar: opciones.quitar === true,
    por: "mke",
  }).replace(/'/g, "'\\''");
  const r = await execEnPod(
    pod,
    `curl -s -m 10 -X POST http://artifact-mishi.${NS_ART}.svc.cluster.local/api/interno/acceso ` +
      `-H 'content-type: application/json' -d '${cuerpo}'`,
  );
  if (!/"ok":true/.test(r.out)) {
    console.log(bad(`acceso NO aplicado: ${r.out.slice(0, 200) || "artifact-mishi no responde"}`));
    return false;
  }
  const donde = artifact === "*" ? "TODOS los artifacts" : `${artifact}${SUFIJO}`;
  console.log(ok(opciones.quitar ? `acceso quitado: ${sujeto} → ${donde}` : `acceso dado: ${sujeto} → ${donde}`));
  console.log(info("la guardia cachea el veredicto 60 s por email|artifact"));
  return true;
}

/** borra del PVC + CNAME + BD. La historia queda en git (recuperable con publicar). */
export async function artifactBorrar(nombre: string): Promise<void> {
  const host = hostDe(nombre);
  const pod = await podStatic();
  if (pod) {
    await execEnPod(pod, `rm -rf ${carpetaPvc(nombre)}`);
    console.log(ok(`borrado del PVC ${dim(carpetaPvc(nombre))}`));
    // purga la BD (registro + datos + accesos + manifiesto): sin esto, un
    // `publicar` futuro con el MISMO nombre heredaría datos/privados/manifiesto
    // viejos (fuga por reuso de nombre). El fuente en git NO se toca: revive.
    const cuerpo = JSON.stringify({ artifact: nombre }).replace(/'/g, "'\\''");
    const r = await execEnPod(
      pod,
      `curl -s -m 10 -X POST http://artifact-mishi.${NS_ART}.svc.cluster.local/api/interno/purgar ` +
        `-H 'content-type: application/json' -d '${cuerpo}'`,
    );
    const docs = /"documentos":(\d+)/.exec(r.out)?.[1];
    if (/"ok":true/.test(r.out)) console.log(ok(`datos purgados de la BD ${dim(`(${docs ?? 0} documentos)`)}`));
    else console.log(warn(`purga de datos NO confirmada: ${r.out.slice(0, 160) || "artifact-mishi no responde"}`));
  } else {
    console.log(warn("no encuentro el pod de static-mishi; PVC sin tocar"));
  }
  try {
    const n = await deleteRecordsByName(host);
    console.log(ok(`DNS: ${n} record(s) borrados (${host})`));
  } catch (e) {
    console.log(warn(`DNS: ${(e as Error).message}`));
  }
  const dir = join(cloneDir(), nombre);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    await archivar(nombre, `borrar ${nombre} (la historia queda en git)`);
  }
  console.log(info("la historia queda en artifacts-mishi: `mke artifact publicar` lo revive"));
}
