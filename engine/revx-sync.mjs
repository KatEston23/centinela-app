// Uso: node engine/revx-sync.mjs
// Lee los saldos de Revolut X con la CLI oficial (solo lectura) y escribe out/crypto.json.
// Si la CLI no está configurada, lo indica y sale sin error para no romper la rutina.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const at = new Date().toISOString();
mkdirSync(join(ROOT, "out"), { recursive: true });
function run(args) {
  // En Windows los .cmd necesitan shell; los argumentos son fijos, sin datos externos
  const opts = { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] };
  return process.platform === "win32" ? execSync(["revx", ...args].join(" "), opts) : execFileSync("revx", args, opts);
}
let out;
try {
  const raw = JSON.parse(run(["account", "balances", "--json"]));
  const list = Array.isArray(raw) ? raw : raw.balances || raw.data || [];
  const assets = list
    .map((b) => ({
      asset: String(b.currency || b.asset || b.symbol || "").toUpperCase(),
      qty: Number(b.total ?? (Number(b.available || 0) + Number(b.reserved || 0)) ?? b.balance),
    }))
    .filter((b) => b.asset && b.qty > 0);
  // Coste medio en EUR a partir del historial (solo lectura): compras suman, ventas restan en proporción
  for (const a of assets) {
    try {
      const tx = JSON.parse(run(["transaction", "list", "--currencies", a.asset, "--start-date", "1825d", "--limit", "500", "--json"]));
      const rows = (tx.data || []).filter((t) => t.status === "completed").sort((x, y) => x.created_date - y.created_date);
      let qty = 0, cost = 0;
      for (const t of rows) {
        if (t.type === "buy" && t.destination?.currency === a.asset && t.source?.currency === "EUR") {
          qty += Number(t.destination.amount); cost += Number(t.source.amount);
        } else if (t.type === "sell" && t.source?.currency === a.asset && qty > 0) {
          const q = Math.min(qty, Number(t.source.amount)); cost -= cost * (q / qty); qty -= q;
        }
      }
      if (qty > 0 && cost > 0) { a.costEur = Math.round(cost * 100) / 100; a.avgEur = Math.round((cost / qty) * 100) / 100; a.buys = rows.filter((t) => t.type === "buy").length; }
    } catch { /* sin historial: queda sin coste */ }
  }
  out = { configured: true, at, assets };
} catch (e) {
  out = { configured: false, at, error: String(e.stderr || e.message || e).slice(0, 300) };
}
writeFileSync(join(ROOT, "out", "crypto.json"), JSON.stringify(out));
console.log(JSON.stringify(out, null, 1));
