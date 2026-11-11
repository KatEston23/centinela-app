"""Genera la base de datos en Excel de Centinela a partir del volcado de la BD de la dashboard.

Uso:  python engine/excel_db.py
Lee:  out/db/<colección>/<doc>.json  (volcado con ArtifactData list + out_dir)
Crea: out/Centinela_BD.xlsx

Hojas: Resumen · Posiciones · Movimientos · Cotizaciones · Señales · Oportunidades · Vigilancia · Configuración
Las columnas calculadas (valor, coste, resultado, totales) son fórmulas: Excel y Google Sheets las
recalculan al abrir. Los precios se refrescan con cada revisión del vigilante.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "out" / "db"
OUT = ROOT / "out" / "Centinela_BD.xlsx"

FONT = "Arial"
INK = "15212A"
ACCENT = "A8670F"
HEAD_FILL = PatternFill("solid", fgColor="15212A")
BAND_FILL = PatternFill("solid", fgColor="F2F4F3")
INPUT_FILL = PatternFill("solid", fgColor="FFF4CC")
GAIN, LOSS = "17804F", "BC3A33"
thin = Side(style="thin", color="D5DCDA")


def load_col(name):
    d = DB / name
    if not d.exists():
        return {}
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(d.glob("*.json"))}


def load_doc(col, doc):
    return load_col(col).get(doc)


def iso_to_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        return None


def header(ws, cols, row=1):
    for i, (title, width) in enumerate(cols, start=1):
        c = ws.cell(row=row, column=i, value=title)
        c.font = Font(name=FONT, bold=True, color="FFFFFF", size=10)
        c.fill = HEAD_FILL
        c.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.row_dimensions[row].height = 30
    ws.freeze_panes = ws.cell(row=row + 1, column=1)


def body_style(ws, first_row, last_row, ncols, wrap_cols=()):
    for r in range(first_row, last_row + 1):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = Font(name=FONT, size=10, color=INK)
            cell.border = Border(bottom=thin)
            cell.alignment = Alignment(vertical="top", wrap_text=c in wrap_cols)
            if (r - first_row) % 2 == 1:
                cell.fill = BAND_FILL


def pnl_colors(ws, ref):
    ws.conditional_formatting.add(ref, CellIsRule(operator="greaterThan", formula=["0"], font=Font(name=FONT, color=GAIN, bold=True)))
    ws.conditional_formatting.add(ref, CellIsRule(operator="lessThan", formula=["0"], font=Font(name=FONT, color=LOSS, bold=True)))


def holdings(ledger_rows, crypto, positions):
    """Mismo criterio que la dashboard: coste medio; coste en € al cambio del día de compra."""
    h = {}
    for r in sorted(ledger_rows, key=lambda x: x["d"]):
        if not r.get("t") or r["k"] not in ("buy", "sell", "split"):
            continue
        x = h.setdefault(r["t"], {"qty": 0.0, "cost": 0.0, "cost_eur": 0.0, "cur": r.get("cur") or "USD"})
        q = r.get("q") or 0.0
        if r["k"] == "buy":
            amt = q * r["p"] if r.get("p") is not None else abs(r.get("tot") or 0)
            x["qty"] += q
            x["cost"] += amt
            amt_eur = amt if x["cur"] == "EUR" else (amt / r["fx"] if r.get("fx") else None)
            x["cost_eur"] = None if x["cost_eur"] is None or amt_eur is None else x["cost_eur"] + amt_eur
        elif r["k"] == "sell":
            sq = min(q, x["qty"])
            share = sq / x["qty"] if x["qty"] else 0
            avg = x["cost"] / x["qty"] if x["qty"] else 0
            if x["cost_eur"] is not None:
                x["cost_eur"] -= x["cost_eur"] * share
            x["qty"] -= sq
            x["cost"] -= sq * avg
        else:
            x["qty"] += q
    out = []
    for t, x in h.items():
        if x["qty"] > 1e-9:
            out.append({"label": t, "quote": t.replace(".", "-"), "qty": x["qty"], "avg": x["cost"] / x["qty"], "cur": x["cur"], "cost_eur": x["cost_eur"], "source": "Revolut Invest"})
    if crypto and crypto.get("configured"):
        costs = (positions or {}).get("cryptoCost", {})
        for a in crypto.get("assets", []):
            if a["asset"] in ("EUR", "USD", "GBP"):
                continue
            avg = (costs.get(a["asset"]) or {}).get("avg")
            out.append({"label": a["asset"], "quote": f'{a["asset"]}-EUR', "qty": a["qty"], "avg": avg, "cur": "EUR", "cost_eur": a["qty"] * avg if avg else None, "source": "Revolut X"})
    for m in (positions or {}).get("manual", []):
        if any(o["quote"] == m["symbol"] for o in out):
            continue
        cost_eur = m["qty"] * m["avg"] if m.get("avg") and m.get("cur", "EUR") == "EUR" else None
        out.append({"label": m["symbol"], "quote": m["symbol"], "qty": m["qty"], "avg": m.get("avg"), "cur": m.get("cur", "EUR"), "cost_eur": cost_eur, "source": "A mano"})
    return out


def main():
    ledger = load_doc("ledger", "invest") or {"rows": []}
    crypto = load_doc("crypto", "revx")
    positions = load_doc("settings", "positions") or {}
    quotes = load_col("quotes")
    signals = sorted(load_col("signals").values(), key=lambda s: s.get("at", ""), reverse=True)
    scan = load_doc("scan", "latest") or {}
    watch = list(load_col("watch").values())
    status = load_doc("status", "engine") or {}
    now = datetime.now()

    wb = Workbook()

    # ---------- Resumen ----------
    ws = wb.active
    ws.title = "Resumen"
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 22
    ws.column_dimensions["C"].width = 60
    ws["A1"] = "Centinela · Base de datos de inversiones"
    ws["A1"].font = Font(name=FONT, size=16, bold=True, color=INK)
    ws["A2"] = f"Generado el {now:%d/%m/%Y a las %H:%M}. Se regenera con cada revisión diaria del vigilante."
    ws["A2"].font = Font(name=FONT, size=10, color="5B6A72")
    rows = [
        ("Valor de la cartera (€)", "=SUM(Posiciones!I:I)", "Suma de la columna «Valor (€)» de Posiciones."),
        ("Invertido (€)", "=SUM(Posiciones!J:J)", "Coste en euros al cambio del día de cada compra."),
        ("Ganancia / pérdida (€)", "=B4-B5", ""),
        ("Ganancia / pérdida (%)", "=IFERROR(B6/B5,0)", ""),
        ("Posiciones abiertas", "=COUNTA(Posiciones!A:A)-1", ""),
        ("Señales registradas", "=COUNTA('Señales'!A:A)-1", ""),
        ("Última revisión de la cartera", iso_to_dt(status.get("portfolioAt")), "Cada 4 horas mientras la app de Claude está abierta en el PC."),
        ("Último escáner de mercado", iso_to_dt(status.get("scanAt")), "Cada día a las 08:30."),
        ("Nota del vigilante", status.get("note", ""), ""),
    ]
    for i, (k, v, note) in enumerate(rows, start=4):
        ws.cell(row=i, column=1, value=k).font = Font(name=FONT, size=11, color="5B6A72")
        c = ws.cell(row=i, column=2, value=v)
        c.font = Font(name=FONT, size=12, bold=True, color=INK)
        ws.cell(row=i, column=3, value=note).font = Font(name=FONT, size=9, color="5B6A72")
        for col in (1, 2, 3):
            ws.cell(row=i, column=col).border = Border(bottom=thin)
    ws["B4"].number_format = ws["B5"].number_format = ws["B6"].number_format = '#,##0.00 "€";-#,##0.00 "€";-'
    ws["B7"].number_format = "0.0%;-0.0%;-"
    ws["B10"].number_format = ws["B11"].number_format = "dd/mm/yyyy hh:mm"
    ws["B12"].alignment = Alignment(wrap_text=True, vertical="top")
    pnl_colors(ws, "B6:B7")
    ws["A15"] = "Cómo se usa"
    ws["A15"].font = Font(name=FONT, size=12, bold=True, color=ACCENT)
    help_lines = [
        "Los extractos de Revolut van en Drive › Inversiones › 01 Extractos Revolut. El vigilante importa el más reciente.",
        "Esta hoja la regenera el vigilante: no hace falta editarla. Las celdas en amarillo de «Configuración» sí puede cambiarlas.",
        "La dashboard en vivo: https://claude.ai/artifact/7oLDVyGyyRsqW5nLq74kgT",
        "Las señales son estadísticas y resúmenes de noticias, no asesoramiento financiero.",
    ]
    for i, t in enumerate(help_lines, start=16):
        ws.cell(row=i, column=1, value="• " + t).font = Font(name=FONT, size=10, color=INK)

    # ---------- Posiciones ----------
    ws = wb.create_sheet("Posiciones")
    cols = [("Activo", 12), ("Nombre", 26), ("Origen", 15), ("Cantidad", 14), ("Precio medio", 14), ("Divisa", 8),
            ("Precio actual", 14), ("€ por unidad de divisa", 14), ("Valor (€)", 14), ("Invertido (€)", 14),
            ("Resultado (€)", 14), ("Resultado (%)", 12), ("Hoy (%)", 10), ("RSI 14", 9), ("Desde máximos", 12)]
    header(ws, cols)
    H = holdings(ledger.get("rows", []), crypto, positions)
    for r, h in enumerate(H, start=2):
        q = quotes.get(h["quote"].replace(".", "_")) or quotes.get(h["quote"]) or {}
        ws.cell(row=r, column=1, value=h["label"])
        ws.cell(row=r, column=2, value=q.get("name", ""))
        ws.cell(row=r, column=3, value=h["source"])
        ws.cell(row=r, column=4, value=h["qty"]).number_format = "#,##0.########"
        ws.cell(row=r, column=5, value=h["avg"]).number_format = "#,##0.00"
        ws.cell(row=r, column=6, value=h["cur"])
        ws.cell(row=r, column=7, value=q.get("price")).number_format = "#,##0.00"
        ws.cell(row=r, column=8, value=q.get("eurPer")).number_format = "0.0000"
        ws.cell(row=r, column=9, value=f"=IFERROR(D{r}*G{r}*H{r},0)").number_format = "#,##0.00"
        ws.cell(row=r, column=10, value=h["cost_eur"] if h["cost_eur"] is not None else f"=IFERROR(D{r}*E{r}*H{r},0)").number_format = "#,##0.00"
        ws.cell(row=r, column=11, value=f"=I{r}-J{r}").number_format = "#,##0.00;-#,##0.00;-"
        ws.cell(row=r, column=12, value=f"=IFERROR(K{r}/J{r},0)").number_format = "0.0%;-0.0%;-"
        ws.cell(row=r, column=13, value=q.get("change1d")).number_format = "0.0%;-0.0%;-"
        ws.cell(row=r, column=14, value=q.get("rsi14")).number_format = "0"
        ws.cell(row=r, column=15, value=q.get("drawdown")).number_format = "0.0%;-0.0%;-"
    last = max(2, len(H) + 1)
    body_style(ws, 2, last, len(cols))
    pnl_colors(ws, f"K2:M{last}")
    if H:
        c = ws.cell(row=2, column=10)
        from openpyxl.comments import Comment
        c.comment = Comment("Coste en euros con el tipo de cambio («FX Rate») de cada compra del extracto de Revolut.", "Centinela")

    # ---------- Movimientos ----------
    ws = wb.create_sheet("Movimientos")
    kinds = {"buy": "Compra", "sell": "Venta", "div": "Dividendo", "split": "Desdoblamiento", "fee": "Comisión", "cash": "Movimiento de efectivo"}
    cols = [("Fecha", 18), ("Ticker", 10), ("Tipo", 20), ("Cantidad", 14), ("Precio por acción", 16), ("Importe total", 14), ("Divisa", 8), ("Cambio (divisa por €)", 16), ("Importe (€)", 14)]
    header(ws, cols)
    rows = ledger.get("rows", [])
    for r, m in enumerate(rows, start=2):
        ws.cell(row=r, column=1, value=iso_to_dt(m["d"])).number_format = "dd/mm/yyyy hh:mm"
        ws.cell(row=r, column=2, value=m.get("t") or "")
        ws.cell(row=r, column=3, value=kinds.get(m["k"], m["k"]))
        ws.cell(row=r, column=4, value=m.get("q")).number_format = "#,##0.########"
        ws.cell(row=r, column=5, value=m.get("p")).number_format = "#,##0.00"
        ws.cell(row=r, column=6, value=m.get("tot")).number_format = "#,##0.00"
        ws.cell(row=r, column=7, value=m.get("cur"))
        ws.cell(row=r, column=8, value=m.get("fx")).number_format = "0.0000"
        ws.cell(row=r, column=9, value=f'=IF(G{r}="EUR",F{r},IFERROR(F{r}/H{r},""))').number_format = "#,##0.00"
    body_style(ws, 2, max(2, len(rows) + 1), len(cols))
    ws.cell(row=len(rows) + 3, column=1, value=f'Origen: {ledger.get("fileName", "sin importar")} (importado {ledger.get("importedAt", "")[:10]}).').font = Font(name=FONT, size=9, italic=True, color="5B6A72")

    # ---------- Cotizaciones ----------
    ws = wb.create_sheet("Cotizaciones")
    cols = [("Símbolo", 12), ("Nombre", 28), ("Tipo", 9), ("Precio", 13), ("Divisa", 8), ("Precio (€)", 13), ("Hoy", 9), ("7 días", 9), ("30 días", 9), ("90 días", 9),
            ("RSI 14", 8), ("Media 50", 12), ("Media 200", 12), ("Máx. 52 sem.", 13), ("Desde máximos", 12), ("Volatilidad anual", 12), ("Alertas técnicas", 46), ("Actualizado", 17)]
    header(ws, cols)
    for r, q in enumerate(quotes.values(), start=2):
        vals = [q.get("symbol"), q.get("name"), {"stock": "Acción", "crypto": "Cripto", "etf": "ETF"}.get(q.get("kind"), q.get("kind")), q.get("price"), q.get("currency"), q.get("priceEur"),
                q.get("change1d"), q.get("change7d"), q.get("change30d"), q.get("change90d"), q.get("rsi14"), q.get("sma50"), q.get("sma200"), q.get("high52"), q.get("drawdown"), q.get("volAnnual"),
                "; ".join(t["text"] for t in q.get("triggers", [])), iso_to_dt(q.get("updatedAt"))]
        for c, v in enumerate(vals, start=1):
            ws.cell(row=r, column=c, value=v)
        for c in (4, 6, 12, 13, 14):
            ws.cell(row=r, column=c).number_format = "#,##0.00"
        for c in (7, 8, 9, 10, 15, 16):
            ws.cell(row=r, column=c).number_format = "0.0%;-0.0%;-"
        ws.cell(row=r, column=18).number_format = "dd/mm/yyyy hh:mm"
    last = max(2, len(quotes) + 1)
    body_style(ws, 2, last, len(cols), wrap_cols=(17,))
    pnl_colors(ws, f"G2:J{last}")

    # ---------- Señales ----------
    ws = wb.create_sheet("Señales")
    tiers = {1: "Mi cartera", 2: "En vigilancia", 3: "Mercado"}
    cols = [("Fecha", 17), ("Símbolo", 11), ("Grupo", 13), ("Acción", 11), ("Confianza", 10), ("Titular", 34), ("Motivo", 70), ("Riesgo", 44), ("Precio", 12), ("Divisa", 8), ("Avisado al móvil", 10), ("Fuentes", 60)]
    header(ws, cols)
    for r, s in enumerate(signals, start=2):
        vals = [iso_to_dt(s.get("at")), s.get("symbol"), tiers.get(s.get("tier"), ""), (s.get("action") or "").capitalize(), (s.get("confidence") or 0) / 100,
                s.get("title"), s.get("reason"), s.get("risk"), s.get("price"), s.get("currency"), "Sí" if s.get("notified") else "No",
                "\n".join(f'{x.get("t", "")}: {x.get("u", "")}' for x in s.get("sources", []))]
        for c, v in enumerate(vals, start=1):
            ws.cell(row=r, column=c, value=v)
        ws.cell(row=r, column=1).number_format = "dd/mm/yyyy hh:mm"
        ws.cell(row=r, column=5).number_format = "0%"
        ws.cell(row=r, column=9).number_format = "#,##0.00"
    body_style(ws, 2, max(2, len(signals) + 1), len(cols), wrap_cols=(6, 7, 8, 12))

    # ---------- Oportunidades ----------
    ws = wb.create_sheet("Oportunidades")
    cols = [("Puntuación", 10), ("Símbolo", 10), ("Nombre", 28), ("País", 8), ("Veredicto", 11), ("Confianza", 10), ("Precio", 12), ("Divisa", 8), ("Hoy", 9), ("90 días", 9), ("RSI 14", 8), ("Desde máximos", 12), ("Motivo", 60), ("Noticias", 50), ("Riesgo", 40)]
    header(ws, cols)
    items = scan.get("items", [])
    for r, it in enumerate(items, start=2):
        vals = [it.get("score"), it.get("symbol"), it.get("name"), it.get("country"), (it.get("verdict") or "Sin analizar").capitalize(), (it.get("confidence") or 0) / 100 if it.get("confidence") else None,
                it.get("price"), it.get("currency"), it.get("change1d"), it.get("change90d"), it.get("rsi14"), it.get("drawdown"), it.get("reason"), it.get("news", ""), it.get("risk", "")]
        for c, v in enumerate(vals, start=1):
            ws.cell(row=r, column=c, value=v)
        ws.cell(row=r, column=6).number_format = "0%"
        ws.cell(row=r, column=7).number_format = "#,##0.00"
        for c in (9, 10, 12):
            ws.cell(row=r, column=c).number_format = "0.0%;-0.0%;-"
    last = max(2, len(items) + 1)
    body_style(ws, 2, last, len(cols), wrap_cols=(13, 14, 15))
    pnl_colors(ws, f"I2:J{last}")
    ws.cell(row=last + 2, column=1, value=f'Escáner del {scan.get("at", "")[:10]} sobre {scan.get("analyzed", "?")} valores. Puntuación técnica 0-100 ajustada con noticias.').font = Font(name=FONT, size=9, italic=True, color="5B6A72")

    # ---------- Vigilancia ----------
    ws = wb.create_sheet("Vigilancia")
    cols = [("Símbolo", 12), ("Nombre", 30), ("Añadido", 17), ("Por", 12)]
    header(ws, cols)
    for r, w in enumerate(watch, start=2):
        ws.cell(row=r, column=1, value=w.get("symbol"))
        ws.cell(row=r, column=2, value=w.get("name"))
        ws.cell(row=r, column=3, value=iso_to_dt(w.get("addedAt"))).number_format = "dd/mm/yyyy hh:mm"
        ws.cell(row=r, column=4, value=w.get("by"))
    body_style(ws, 2, max(2, len(watch) + 1), len(cols))
    if not watch:
        ws["A2"] = "Vacía: el escáner añade aquí las candidatas que repiten como fuertes dos días seguidos."

    # ---------- Configuración ----------
    ws = wb.create_sheet("Configuración")
    header(ws, [("Parámetro", 36), ("Valor", 58), ("Nota", 60)])
    cfg = [
        ("Dashboard", "https://claude.ai/artifact/7oLDVyGyyRsqW5nLq74kgT", "Privada: solo usted puede abrirla."),
        ("Carpeta de Drive", "Inversiones", "01 Extractos Revolut · 02 Base de datos · 03 Informes"),
        ("Revisión de cartera", "Cada 4 h (minuto 5)", "Tarea programada «centinela-cartera-4h»."),
        ("Escáner de mercado", "Diario, 08:30", "Tarea programada «centinela-escaner-diario». Los domingos, resumen semanal."),
        ("Umbral de aviso (confianza)", 0.70, "Se avisa al móvil a partir de esta confianza. Para cambiarlo, dígaselo a JARVIS."),
        ("Umbral de movimiento diario", 0.05, "Aviso si un activo de la cartera se mueve más que esto en un día."),
        ("Máx. avisos por revisión", 3, ""),
    ]
    for r, (k, v, n) in enumerate(cfg, start=2):
        ws.cell(row=r, column=1, value=k)
        ws.cell(row=r, column=2, value=v)
        ws.cell(row=r, column=3, value=n)
    body_style(ws, 2, len(cfg) + 1, 3, wrap_cols=(3,))
    for r in (6, 7, 8):
        ws.cell(row=r, column=2).fill = INPUT_FILL
    ws["B6"].number_format = ws["B7"].number_format = "0%"
    ws.cell(row=len(cfg) + 3, column=1, value="Las celdas en amarillo son parámetros; el resto lo escribe el vigilante.").font = Font(name=FONT, size=9, italic=True, color="5B6A72")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    from openpyxl.workbook.properties import CalcProperties
    wb.calculation = CalcProperties(fullCalcOnLoad=True)  # Excel/Sheets recalculan al abrir
    wb.save(OUT)
    print(json.dumps({"file": str(OUT), "posiciones": len(H), "movimientos": len(rows), "cotizaciones": len(quotes), "senales": len(signals), "oportunidades": len(items)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
