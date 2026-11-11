// Uso:
//   node engine/util.mjs clean-db          → borra out/db antes de volcar la BD
//   node engine/util.mjs stage <carpeta>   → copia out/Centinela_BD.xlsx a <carpeta> e imprime su sha256 y ruta
// Existe para que las rutinas no necesiten rm/cp/sha256sum (que pedirían permiso).
import { rmSync, copyFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "./lib.mjs";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "clean-db") {
  rmSync(join(ROOT, "out", "db"), { recursive: true, force: true });
  console.log("out/db borrada");
} else if (cmd === "stage" && arg) {
  mkdirSync(arg, { recursive: true });
  const dest = join(arg, "Centinela_BD.xlsx");
  copyFileSync(join(ROOT, "out", "Centinela_BD.xlsx"), dest);
  const hash = createHash("sha256").update(readFileSync(dest)).digest("hex");
  console.log(JSON.stringify({ sha256: hash, path: dest.replace(/\\/g, "/") }));
} else {
  console.error("Uso: clean-db | stage <carpeta>");
  process.exit(1);
}
