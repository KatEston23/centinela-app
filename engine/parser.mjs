// Reutiliza EXACTAMENTE el lector de extractos y el cálculo de posiciones de la dashboard
// (se extraen de web/centinela.html para no tener dos versiones de la misma lógica).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const html = readFileSync(join(ROOT, "web", "centinela.html"), "utf8");
const src = html.split("<script>")[1].split("</script>")[0];
const grab = (n) => {
  const i = src.indexOf("function " + n + "(");
  if (i < 0) throw new Error("No encuentro " + n + " en centinela.html");
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; if (src[k] === "}" && !--d) return src.slice(i, k + 1); }
};
const S = { settings: { map: {} } };
export const { importRevolut, holdingsFromLedger } = new Function("S",
  ["splitCSV", "parseNum", "parseDate", "curOf", "importRevolut", "holdingsFromLedger"].map(grab).join("\n") +
  "\nreturn { importRevolut, holdingsFromLedger };")(S);
