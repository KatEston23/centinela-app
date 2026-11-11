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
      "verdict": "comprar | reforzar | mantener | reducir | vender | vigilar",
      "confidence": 0,
      "title": "máx. 60 caracteres",
      "reason": "2-3 frases con datos concretos",
      "news": "1-2 frases",
      "risk": "1 frase",
      "sources": [{ "t": "titular", "u": "https://..." }]
    }
  }
}
```

Si la rutina no se ejecuta (sin tokens), el motor sigue funcionando con señales estadísticas.
