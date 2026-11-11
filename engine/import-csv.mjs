// Uso: node engine/import-csv.mjs <extracto.csv>
// Usa EXACTAMENTE el mismo lector que la dashboard (lo extrae de web/centinela.html)
// y escribe out/ledger-invest.json (documento ledger/invest) y out/portfolio-summary.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT } from "./lib.mjs";

const file = process.argv[2];
if (!file) { console.error("Indica el CSV"); process.exit(1); }
const html = readFileSync(join(ROOT, "web", "centinela.html"), "utf8");
const src = html.split("<script>")[1].split("</script>")[0];
const grab = (n) => { const i = src.indexOf("function " + n + "("); let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; if (src[k] === "}" && !--d) return src.slice(i, k + 1); } };
const S = { settings: { map: {} } };
const api = new Function("S", ["splitCSV", "parseNum", "parseDate", "curOf", "importRevolut", "holdingsFromLedger"].map(grab).join("\n") + "\nreturn { importRevolut, holdingsFromLedger };")(S);
const rows = api.importRevolut(readFileSync(file, "utf8"));
const H = api.holdingsFromLedger(rows);
const at = new Date().toISOString();
mkdirSync(join(ROOT, "out"), { recursive: true });
writeFileSync(join(ROOT, "out", "ledger-invest.json"), JSON.stringify({ rows, fileName: basename(file), importedAt: at }));
writeFileSync(join(ROOT, "out", "portfolio-summary.json"), JSON.stringify({ symbols: H.map((h) => ({ symbol: h.quote, label: h.symbol, qty: h.qty, avg: h.avg, cur: h.cur, source: h.source })), updatedAt: at }));
console.log(JSON.stringify({ movimientos: rows.length, posiciones: H }, null, 1));
