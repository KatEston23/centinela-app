// Uso: node engine/notify.mjs "Título" "Mensaje" [prioridad 1-5] [etiquetas,separadas]
// Envía una notificación push al móvil a través de ntfy (canal privado en config.local.json).
// No incluya importes ni saldos en el mensaje: el canal es secreto, pero no está cifrado.
import { loadConfig } from "./lib.mjs";

const [title, message, priority = "3", tags = ""] = process.argv.slice(2);
const cfg = loadConfig();
if (!cfg.ntfyTopic) { console.error("Falta ntfyTopic en config.local.json"); process.exit(1); }
if (!title || !message) { console.error('Uso: node engine/notify.mjs "Título" "Mensaje" [prioridad] [etiquetas]'); process.exit(1); }

const server = cfg.ntfyServer || "https://ntfy.sh";
// El título va en RFC 2047 (base64) para que tildes y símbolos lleguen bien
const headers = { Title: `=?UTF-8?B?${Buffer.from(title).toString("base64")}?=`, Priority: String(priority), "Content-Type": "text/plain; charset=utf-8" };
if (tags) headers.Tags = tags;
// iOS no puede abrir la app de la pantalla de inicio desde un aviso: tocar abre ntfy, y un botón opcional abre el navegador
  headers.Actions = `view, Abrir en el navegador, ${cfg.pwaUrl}`;

const r = await fetch(`${server}/${cfg.ntfyTopic}`, { method: "POST", headers, body: message });
console.log(r.ok ? "enviada" : `error ${r.status}: ${await r.text()}`);
process.exit(r.ok ? 0 : 1);
