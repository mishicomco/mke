// Runtime v1 de artifacts — barra superior estandar + window.mishi.
// CONTRATO ESTABLE (ver mishi.css). Fase 1: sesion/datos avisan que llegan en
// Fase 2 (artifact-mishi); el prototipo usa localStorage.
(() => {
  const artifact = location.hostname.split(".")[0].replace(/-artifact$/, "");

  const sinDatos = () => {
    throw new Error(
      "mishi.datos llega en Fase 2 (artifact-mishi). Por ahora usa localStorage.",
    );
  };

  window.mishi = {
    artifact,
    // Fase 2: sesion del IdP (cookie mishi_sesion validada por artifact-mishi).
    sesion: null,
    datos: { guardar: sinDatos, leer: sinDatos, lista: sinDatos, borrar: sinDatos },
  };

  // Barra superior estandar. Opt-out: <body data-sin-barra>.
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.hasAttribute("data-sin-barra")) return;
    const barra = document.createElement("header");
    barra.className = "barra-mishi";
    const nombre = document.createElement("span");
    nombre.className = "barra-nombre";
    nombre.textContent = document.title || artifact;
    const sello = document.createElement("span");
    sello.className = "barra-sello";
    sello.textContent = "artifact";
    sello.title = "Prototipo sin repo propio ni BD. Graduar = mke artifact graduar.";
    barra.append(nombre, sello);
    document.body.prepend(barra);
  });
})();
