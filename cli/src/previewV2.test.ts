import { test } from "node:test";
import assert from "node:assert/strict";
import { carrilesDeDiff, manifiestosPreviewV2 } from "./previewV2.js";

test("carrilesDeDiff: apps/backend toca el carril back", () => {
  assert.deepEqual(carrilesDeDiff(["apps/backend/index.ts"]), { back: true, front: false });
});

test("carrilesDeDiff: apps/frontend toca el carril front", () => {
  assert.deepEqual(carrilesDeDiff(["apps/frontend/src/App.tsx"]), { back: false, front: true });
});

test("carrilesDeDiff: packages/contract toca el carril front (frontera tipada)", () => {
  assert.deepEqual(carrilesDeDiff(["packages/contract/src/schema.ts"]), { back: false, front: true });
});

test("carrilesDeDiff: package-lock.json toca el carril back (npm ci se repite)", () => {
  assert.deepEqual(carrilesDeDiff(["package-lock.json"]), { back: true, front: false });
});

test("carrilesDeDiff: ambos si tocan ambos árboles", () => {
  assert.deepEqual(carrilesDeDiff(["apps/backend/index.ts", "apps/frontend/src/App.tsx"]), { back: true, front: true });
});

test("carrilesDeDiff: sin paths relevantes → ninguno", () => {
  assert.deepEqual(carrilesDeDiff(["README.md"]), { back: false, front: false });
});

test("manifiestosPreviewV2: forma completa trae postgres+backend+front, sin initContainer ni ConfigMap de scripts de dev", () => {
  const items = manifiestosPreviewV2({
    app: "hello-mishi",
    rama: "feat/x",
    imagenRef: "hello-mishi-preview-v2:abc123",
    sha: "abc123",
    leaseId: "lease-1",
    leaseToken: "tok-1",
    config: { FOO: "bar" },
    forma: { backend: true, frontend: true },
  });

  const deployment = items.find((i) => (i as { kind?: string }).kind === "Deployment") as any;
  assert.ok(deployment, "hay Deployment");
  const containers = deployment.spec.template.spec.containers as { name: string; image: string }[];
  assert.ok(containers.some((c) => c.name === "postgres"));
  assert.ok(containers.some((c) => c.name === "backend" && c.image === "hello-mishi-preview-v2:abc123"));
  assert.ok(containers.some((c) => c.name === "front" && c.image === "caddy:2-alpine"));
  assert.equal(deployment.spec.template.spec.initContainers, undefined);

  const secret = items.find((i) => (i as { kind?: string }).kind === "Secret") as any;
  assert.equal(secret.metadata.name, "hello-mishi-feat-x-lease");

  const ingress = items.find((i) => (i as { kind?: string }).kind === "Ingress") as any;
  assert.equal(ingress.spec.rules[0].host, "hello-mishi-feat-x.mishi.com.co");
});

test("manifiestosPreviewV2: backend-only omite postgres y el volumen front", () => {
  const items = manifiestosPreviewV2({
    app: "api-only",
    rama: "main",
    imagenRef: "api-only-preview-v2:sha1",
    sha: "sha1",
    leaseId: "sin-lease",
    config: {},
    forma: { backend: true, frontend: false },
  });
  const deployment = items.find((i) => (i as { kind?: string }).kind === "Deployment") as any;
  const containers = deployment.spec.template.spec.containers as { name: string }[];
  assert.ok(containers.some((c) => c.name === "postgres"));
  assert.ok(!containers.some((c) => c.name === "front" && c.name.includes("nope")));
  const volumes = deployment.spec.template.spec.volumes as { name: string }[];
  assert.ok(!volumes.some((v) => v.name === "front"));
});

test("manifiestosPreviewV2: sin leaseToken no genera el Secret de lease (modo degradado, igual que v1)", () => {
  const items = manifiestosPreviewV2({
    app: "hello-mishi",
    rama: "main",
    imagenRef: "hello-mishi-preview-v2:sha1",
    sha: "sha1",
    leaseId: "sin-lease",
    config: {},
    forma: { backend: true, frontend: true },
  });
  assert.ok(!items.some((i) => (i as { kind?: string }).kind === "Secret"));
});
