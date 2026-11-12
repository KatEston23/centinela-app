// Estado de Centinela: vive cifrado en docs/data.enc.json (lo que lee la app del móvil).
//   node engine/state.mjs decrypt          → docs/data.enc.json  ⇒ out/state.json
//   node engine/state.mjs publish ["msg"]  → out/state.json      ⇒ docs/ (app + datos cifrados), commit y push
//   node engine/state.mjs build            → solo regenera docs/ sin publicar
// Lo usan GitHub Actions (motor base, capa 1) y las rutinas de Claude (capa 2 con IA).
// Nunca se escribe en el repositorio nada sin cifrar.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { ROOT, loadConfig } from "./lib.mjs";

const cfg = loadConfig();
const DOCS = join(ROOT, "docs");
const STATE = join(ROOT, "out", "state.json");
const ITER = 210000;
const keyFrom = (salt) => pbkdf2Sync(String(cfg.pwaKey || "").replace(/[^A-Z0-9]/gi, "").toUpperCase(), salt, ITER, 32, "sha256");

export function encrypt(obj) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(salt), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
}
export function decrypt(env) {
  const ct = Buffer.from(env.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", keyFrom(Buffer.from(env.salt, "base64")), Buffer.from(env.iv, "base64"));
  d.setAuthTag(ct.subarray(-16));
  return JSON.parse(d.update(ct.subarray(0, -16), undefined, "utf8") + d.final("utf8"));
}
export function readState() { return JSON.parse(readFileSync(STATE, "utf8")); }
export function writeState(s) { mkdirSync(join(ROOT, "out"), { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); }

// La app (index.html) se genera desde la dashboard (web/centinela.html) + la piel de móvil
export function buildShell() {
  mkdirSync(join(DOCS, "icons"), { recursive: true });
  let src = readFileSync(join(ROOT, "web", "centinela.html"), "utf8");
  const shim = readFileSync(join(ROOT, "web", "pwa-shim.js"), "utf8");
  const START = "route(); renderAll(); connect();";
  if (!src.includes(START)) throw new Error("No encuentro el arranque en web/centinela.html");
  src = src.replace(START, shim + "\nroute(); renderAll(); pwaStart();");
  const head = readFileSync(join(ROOT, "web", "pwa-head.html"), "utf8");
  const appCss = readFileSync(join(ROOT, "web", "pwa-app.css"), "utf8");
  const version = createHash("sha256").update(src + head + appCss).digest("hex").slice(0, 10);
  // La app conoce su versión y la compara con version.json: si hay una nueva, se recarga sola
  src = src.replace("__APP_VERSION__", version);
  writeFileSync(join(DOCS, "version.json"), JSON.stringify({ v: version }));
  writeFileSync(join(DOCS, "index.html"), `<!doctype html><html lang="es"><head>${head}</head><body>\n${src}\n<style>\n${appCss}</style>\n</body></html>\n`);
  writeFileSync(join(DOCS, "sw.js"), readFileSync(join(ROOT, "web", "pwa-sw.js"), "utf8").replace("__VERSION__", version));
  copyFileSync(join(ROOT, "web", "manifest.webmanifest"), join(DOCS, "manifest.webmanifest"));
  for (const f of readdirSync(join(ROOT, "web", "icons"))) copyFileSync(join(ROOT, "web", "icons", f), join(DOCS, "icons", f));
  writeFileSync(join(DOCS, ".nojekyll"), "");
  return version;
}

// Logos reales: se guardan dentro del estado cifrado; solo se descargan los que faltan
export async function addLogos(s) {
  s.logos = s.logos || {};
  const syms = new Set([
    ...Object.values(s.quotes || {}).map((q) => q.symbol),
    ...(s.scan?.items || []).map((i) => i.symbol),
    ...(s.watch || []).map((w) => w.symbol),
    ...(s.signals || []).map((x) => x.symbol),
  ].filter(Boolean));
  s.logoMiss = s.logoMiss || {};
  const fmpId = (x) => /-(EUR|USD)$/.test(x) ? x.replace(/-(EUR|USD)$/, "") + "USD" : x.replace(/\..*$/, "");
  for (const x of syms) {
    if (s.logos[x] || s.logoMiss[x]) continue;
    try {
      const r = await fetch(`https://financialmodelingprep.com/image-stock/${encodeURIComponent(fmpId(x))}.png`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && (r.headers.get("content-type") || "").startsWith("image/png") && buf.length > 300) s.logos[x] = "data:image/png;base64," + buf.toString("base64");
      else s.logoMiss[x] = true;
    } catch { /* sin red: se reintenta la próxima vez */ }
  }
}

const git = (a, cwd = ROOT, soft = false) => {
  try { return execSync("git " + a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { if (soft) return ""; throw e; }
};

// La web pública (repo centinela-app) solo recibe la app y los datos cifrados, en un único
// commit que sustituye al anterior: no guarda historial ni nada del motor.
export function publishApp() {
  const dir = join(ROOT, "out", "app-repo");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(DOCS, dir, { recursive: true });
  const url = git("remote get-url origin");
  git("init -q -b gh-pages", dir);
  // En GitHub Actions se reutiliza la credencial que deja actions/checkout
  const auth = git("config --get http.https://github.com/.extraheader", ROOT, true);
  if (auth) git(`config http.https://github.com/.extraheader "${auth}"`, dir);
  git("add -A", dir);
  git(`-c user.name=Centinela -c user.email=centinela@users.noreply.github.com commit -q -m "App y datos cifrados"`, dir);
  git(`push -q -f ${url} gh-pages`, dir);
  rmSync(dir, { recursive: true, force: true });
}

// El último estado publicado vive en la rama gh-pages (data.enc.json)
function fetchPublished() {
  try { git("fetch -q --depth=1 origin gh-pages"); return git("show FETCH_HEAD:data.enc.json"); }
  catch { const f = join(DOCS, "data.enc.json"); return existsSync(f) ? readFileSync(f, "utf8") : null; }
}

async function main() {
  const [cmd, msg] = process.argv.slice(2);
  if (!cfg.pwaKey) throw new Error("Falta la clave (pwaKey / PWA_KEY)");
  if (cmd === "decrypt") {
    const raw = fetchPublished();
    const s = raw ? decrypt(JSON.parse(raw)) : {};
    writeState(s);
    console.log(`estado descifrado: ${Object.keys(s.quotes || {}).length} cotizaciones, ${(s.signals || []).length} señales`);
    return;
  }
  if (cmd === "build" || cmd === "publish") {
    const s = readState();
    await addLogos(s);
    s.at = new Date().toISOString();
    s.signals = (s.signals || []).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 150);
    writeState(s);
    const version = buildShell();
    writeFileSync(join(DOCS, "data.enc.json"), JSON.stringify(encrypt(s)));
    console.log(`docs/ lista (versión ${version}, ${Object.keys(s.quotes || {}).length} cotizaciones, ${s.signals.length} señales)`);
    if (cmd === "build") return;
    // Un solo commit en gh-pages, que sustituye al anterior: sin historial de datos
    publishApp();
    console.log(`App publicada en ${cfg.pwaUrl} (${msg || "datos " + s.at})`);
    return;
  }
  console.error("Uso: decrypt | build | publish [mensaje]");
  process.exit(1);
}
if (process.argv[1] && process.argv[1].endsWith("state.mjs")) main().catch((e) => { console.error(e.message); process.exit(2); });
