// Puente con Google Drive (script de Apps Script en la cuenta del usuario, carpeta «Inversiones»).
// - Importa solos los extractos CSV nuevos de «01 Extractos Revolut» (Invest o Robo-Advisor, por contenido).
// - Una vez al día sube Centinela_BD.xlsx a «02 Base de datos».
// Secretos: DRIVE_BRIDGE_URL (…/exec del script) y DRIVE_BRIDGE_KEY. Sin ellos, no hace nada.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { importRevolut } from "./parser.mjs";
import { ROBO_MAP } from "./robot.mjs";

const URL_ = process.env.DRIVE_BRIDGE_URL, KEY = process.env.DRIVE_BRIDGE_KEY;
export const driveOn = () => !!(URL_ && KEY);

/** ¿Es un extracto del Robo-Advisor? La mayoría de sus tickers son los fondos del robot. */
function isRobot(rows) {
  const t = [...new Set(rows.map((r) => r.t).filter(Boolean))];
  if (!t.length) return false;
  return t.filter((x) => ROBO_MAP[x]).length / t.length >= 0.5;
}

export async function syncDrive(s, now = new Date()) {
  if (!driveOn()) return { off: true };
  s.drive = s.drive || { seen: {} };
  const since = s.drive.since || "2026-11-01T00:00:00Z";
  const r = await fetch(`${URL_}?k=${encodeURIComponent(KEY)}&since=${encodeURIComponent(since)}`, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.ok) throw new Error("puente de Drive: " + (j.error || r.status));
  const out = { files: j.files.length, invest: null, robot: null, skipped: 0 };
  // Del más antiguo al más nuevo: si hay varios, gana el último (los extractos son acumulados)
  for (const f of j.files.sort((a, b) => a.modified.localeCompare(b.modified))) {
    if (s.drive.seen[f.id] === f.modified) continue;
    s.drive.seen[f.id] = f.modified;
    if (f.kind !== "invest") { out.skipped++; continue; } // P&L y Revolut X: el motor ya lo calcula por su cuenta
    let rows = [];
    try { rows = importRevolut(f.text); } catch { /* no es un extracto */ }
    if (!rows.length) { out.skipped++; continue; }
    const doc = { rows, fileName: "Drive " + f.name, driveFileId: f.id, driveModifiedTime: f.modified, importedAt: now.toISOString() };
    if (isRobot(rows)) {
      if (s.robot?.ledger?.driveModifiedTime && s.robot.ledger.driveModifiedTime >= f.modified) continue;
      s.robot = { ...(s.robot || {}), ledger: doc }; out.robot = `${f.name} (${rows.length} mov.)`;
    } else {
      if (s.ledger?.driveModifiedTime && s.ledger.driveModifiedTime >= f.modified) continue;
      // Un extracto con menos movimientos que el actual suele ser parcial: no se pisa lo que ya hay
      if ((s.ledger?.rows?.length || 0) > rows.length) { out.skipped++; continue; }
      s.ledger = doc; out.invest = `${f.name} (${rows.length} mov.)`;
    }
  }
  s.drive.since = j.at || now.toISOString();
  s.drive.at = now.toISOString();
  // Se olvidan las marcas de archivos de hace más de 60 días
  const old = Object.entries(s.drive.seen).filter(([, m]) => now - new Date(m) > 60 * 864e5).map(([k]) => k);
  for (const k of old) delete s.drive.seen[k];
  return out;
}

/** Vuelca el estado en el formato que lee engine/excel_db.py, lo genera y lo sube a Drive. */
export async function uploadExcel(s, docId) {
  if (!driveOn()) return { off: true };
  const db = join(ROOT, "out", "db");
  rmSync(db, { recursive: true, force: true });
  const put = (col, id, v) => { if (v == null) return; mkdirSync(join(db, col), { recursive: true }); writeFileSync(join(db, col, `${id}.json`), JSON.stringify(v)); };
  put("ledger", "invest", s.ledger);
  put("crypto", "revx", s.crypto);
  put("settings", "positions", s.positions);
  put("scan", "latest", s.scan);
  put("status", "engine", s.status);
  for (const [k, q] of Object.entries(s.quotes || {})) put("quotes", k, q);
  for (const x of s.signals || []) put("signals", x.id || docId(x.symbol) + x.at, x);
  for (const w of s.watch || []) put("watch", docId(w.symbol), w);
  execFileSync(process.platform === "win32" ? "python" : "python3", ["-I", join(ROOT, "engine", "excel_db.py")], { stdio: "pipe" });
  const xlsx = join(ROOT, "out", "Centinela_BD.xlsx");
  if (!existsSync(xlsx)) throw new Error("no se generó el Excel");
  const r = await fetch(URL_, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ k: KEY, op: "excel", data: readFileSync(xlsx).toString("base64") }), signal: AbortSignal.timeout(90000) });
  const j = await r.json();
  if (!j.ok) throw new Error("subida del Excel: " + (j.error || r.status));
  return { id: j.id };
}
