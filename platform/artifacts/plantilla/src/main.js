// Modulos ES nativos: importa libre entre archivos de ./src (la CSP permite
// script-src 'self'). Datos: localStorage (mishi.datos.* llega en Fase 2).
// window.mishi trae { artifact, sesion } y el evento "mishi:sesion".

const app = document.getElementById("app");
app.textContent = `hola desde ${window.mishi?.artifact ?? "el artifact"}`;
