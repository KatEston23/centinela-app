// Uso: node engine/revx-sync.mjs
// Lee Revolut X con la CLI oficial (solo lectura) y escribe out/crypto.json. Misma lógica que el motor
// (engine/revx.mjs): staking incluido, coste en EUR de todas las compras y precio en vivo.
// Si la CLI no está configurada, lo indica y sale sin error para no romper la rutina.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { syncRevx } from "./revx.mjs";

mkdirSync(join(ROOT, "out"), { recursive: true });
const file = join(ROOT, "out", "crypto.json");
let prev = null;
try { if (existsSync(file)) prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* sin copia previa */ }
const out = await syncRevx(prev?.configured ? prev : null);
writeFileSync(file, JSON.stringify(out));
console.log(JSON.stringify(out, (k, v) => (k === "lots" ? `${v.length} movimientos` : v), 1));
