# Capa 2 · análisis con IA

Una rutina de Claude en la nube lee cada día `https://kateston23.github.io/centinela-app/ai-request.json`
(datos públicos de mercado, sin cantidades ni nada personal), busca noticias de cada símbolo y escribe
`ai/notes.json` en `main`. Ese push lanza el motor, que integra el análisis en los datos cifrados de la app.

Formato de `ai/notes.json`:

```json
{
  "at": "2026-11-12T08:10:00Z",
  "notes": {
    "NVDA": {
      "verdict": "comprar | reforzar | mantener | reducir | vender | vigilar  (para quien ya lo tiene)",
      "confidence": 0,
      "entry": "comprar | vigilar | evitar  (para quien se plantea invertir)",
      "entryConfidence": 0,
      "watchFor": "qué tendría que pasar para comprar",
      "title": "máx. 60 caracteres",
      "reason": "2-3 frases con datos concretos",
      "news": "1-2 frases",
      "risk": "1 frase",
      "sources": [{ "t": "titular", "u": "https://..." }]
    }
  }
}
```

Desde el 2026-11-12 la rutina aplica las skills de `.claude/skills/` (market-news-analyst, scenario-analyzer,
us-stock-analysis, thesis-tracker, catalyst-calendar, crypto-regime-analyzer) y añade al formato:
`market` {regime, summary, events[{t, impact, affects, u}], scenarios[{name, prob, effect}], catalysts[{d, e, imp}]},
`crypto` {summary} y, por símbolo, `thesis`, `breaks`, `valuation` y `catalysts`. Las instrucciones completas
están en la rutina de Claude (copia local en `prompts/rutina-ia.md`). El régimen cripto lo calcula `.github/workflows/regime.yml` una vez al día
y lo deja en `ai/crypto-regime.json`; el motor lo pasa a la IA en `ai-request.json` (`cryptoRegime`).

Si la rutina no se ejecuta (sin tokens), el motor sigue funcionando con señales estadísticas.
