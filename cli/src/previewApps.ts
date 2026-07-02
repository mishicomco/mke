// Conocimiento POR APP para armar su preview efímero. Las apps NO tienen overlay
// de preview (siguen `estructura-apps-mishi`: k8s/{base,overlays/{local,stage,prod}}),
// así que el generador vive acá: reusa la BASE del app + parches que inyecta el CLI.
//
// Lo único app-específico es cómo se llama el Secret que la base referencia y qué
// llaves espera. DATABASE_URL se inyecta aparte (apunta al postgres efímero del
// namespace). Todo lo demás es fail-closed como stage (nada de modo prod) + el
// flag PREVIEW=true para que Studio siembre por escenario si la app lo soporta.

/** valor de una llave del Secret: literal fijo, o leído de mishi-secret (GPG). */
export type SecretValue = string | { fromSecret: string };

export interface PreviewApp {
  /** puerto del contenedor del backend (la base ya mapea el Service 80->targetPort). */
  containerPort: number;
  /** nombre del Deployment en la base (si difiere del id del app). */
  deployName?: string;
  /** ruta del Dockerfile relativa al repo (context SIEMPRE = raíz del repo). */
  dockerfile?: string;
  /** nombre del Secret que la base referencia por secretKeyRef. */
  secretName: string;
  /**
   * llaves NO-DB del Secret. DATABASE_URL lo pone el CLI (postgres efímero).
   * Las llaves marcadas `optional` en la base pueden faltar sin romper el arranque.
   */
  secretLiterals: Record<string, SecretValue>;
  /** BD efímera: nombre/rol/pass del postgres del namespace. */
  db: { name: string; user: string; password: string };
  /** el nombre de la env que lleva la DATABASE_URL (default DATABASE_URL). */
  databaseUrlKey?: string;
}

// Fallback genérico para apps aún no registradas: intenta `<app>-secrets` con solo
// DATABASE_URL. Si la base pide más llaves, el arranque fallará y el doctor lo dirá.
function fallback(app: string): PreviewApp {
  return {
    containerPort: 3000,
    secretName: `${app}-secrets`,
    secretLiterals: {},
    db: { name: app.replace(/-/g, "_"), user: app.replace(/-/g, "_"), password: "preview" },
  };
}

const REGISTRY: Record<string, PreviewApp> = {
  "mishi-bank": {
    containerPort: 3000,
    deployName: "mishi-bank",
    dockerfile: "apps/backend/Dockerfile",
    secretName: "mishi-bank-secrets",
    // Google login NO funciona en un host de preview arbitrario (orígenes no
    // autorizados en la consola de Google); el acceso en preview es la ruta OTP/
    // seed de Studio (PREVIEW=true). El CLIENT_ID real es inofensivo aquí.
    secretLiterals: {
      GOOGLE_CLIENT_ID: { fromSecret: "mishi-google-client-id" },
      SESSION_SECRET: "__RANDOM__", // el CLI lo reemplaza por un aleatorio de 32 hex
      ALLOWED_EMAILS: "santiramirezc@gmail.com",
    },
    db: { name: "bank", user: "bank", password: "preview" },
  },
};

export function previewApp(app: string): PreviewApp {
  return REGISTRY[app] ?? fallback(app);
}
