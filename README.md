# Audio zu Text

Eine Website, die Audio- und Videodateien mit [Whisper](https://github.com/openai/whisper) in Text und Untertitel umwandelt – **komplett im Browser**. Keine Datei verlässt das Gerät.

**Adresse (nach dem Einschalten von GitHub Pages):** https://richardmatz21-creator.github.io/Claude-Code/

## Was die Seite kann

- Audio- und Videodateien per Drag & Drop oder Auswahl, auch mehrere auf einmal (Warteschlange)
- Zwei Qualitätsstufen: **Ausgewogen** (Whisper small, Standard) und **Schnell** (Whisper base)
- Sprache standardmäßig Deutsch, umstellbar oder automatisch
- Ergebnis als Text (kopieren oder TXT) und Untertitel (SRT), mehrere Dateien als ZIP
- **Sprecher erkennen** (Schalter): wer spricht wann, Namen umbenennbar, in Text und SRT
- **Text korrigieren:** direkt im Text klicken und tippen (geänderte Stellen gelb markiert), Stelle anhören per ▶ oder Strg+Leertaste, „Satz für Satz korrigieren“ mit Anhören und Weiter-Knopf, „Suchen & Ersetzen“ mit Rückgängig, Original pro Abschnitt wiederherstellen, geleerte Abschnitte fallen aus TXT/SRT heraus. Korrekturen landen automatisch in Text, Untertiteln, TXT, SRT und ZIP.
- **Textgerüst** (Tab): ordnet das Material automatisch in **OFF** (ab 2 s Pause beim Wechsel der Stimme, einstellbar; spricht dieselbe Person weiter, erst ab 8 s; ohne Sprecher-Erkennung gilt die gewählte Länge überall; mit „Sprecher erkennen“ werden Pausen auch unter Musik erkannt; englische Liedtexte zählen bei Sprache Deutsch nicht – weggelassener Text bleibt als Hinweis am Block sichtbar), **OT** (eine Person spricht länger am Stück, ab ca. 8 s) und **Sit** (Hin und Her von zwei oder mehr Stimmen, Frage und Antwort, direkte Antworten ohne Pause) ein und kürzt jede Aussage auf „erste 3 Wörter…Schlagwörter…letzte 3 Wörter“ (Schieberegler für die Stärke, Blöcke bis 10 Wörter bleiben ganz). Jeder Block lässt sich umstellen (OT/Sit/OFF), umbenennen (z. B. „OT Anna & Ben“), anhören und bearbeiten, OFF-Blöcke nehmen optional Sprechertext auf. Download als Word-Datei im Layout der Textgerüst-Vorlage (Querformat, 3 Spalten, grüne Titelzeile, OFF fett, Timecode rechts). Schlagwörter werden nach Regeln gewählt (Hauptwörter, Namen, Zahlen, seltene Wörter) – keine KI.
- Es wird nichts gespeichert: Beim Schließen warnt die Seite, solange Ergebnisse oder Korrekturen nicht heruntergeladen sind
- Filter für typische erfundene Whisper-Sätze bei Stille („Untertitel im Auftrag des ZDF …“) und Wiederholungsschleifen
- Nutzt die Grafikkarte (WebGPU mit fp16), sonst den Prozessor mit mehreren Kernen
- Fortschritt mit Restzeit, Abbrechen, Bildschirm bleibt während der Umwandlung an

## Benutzen

Seite in **Chrome oder Edge** öffnen, Dateien hineinziehen, „Umwandeln starten“. Beim allerersten Mal wird das Sprachmodell einmalig geladen und danach im Browser gespeichert (siehe Tabelle unten). Während der Umwandlung den Tab sichtbar lassen.

Mit `?modus=prozessor` an der Adresse lässt sich der Prozessor-Modus erzwingen (zur Fehlersuche). Mit `?debug` legt die Seite die Rohdaten der Umwandlung (Abschnitte, Sprach-Zeitleiste, Stimm-Fingerabdrücke) in `window.__azt` ab, um die Textgerüst-Regeln auszuwerten – nur im eigenen Browser, es wird nichts gesendet.

## Veröffentlichen (einmalig einrichten)

1. Repo öffentlich machen: *Settings → General → Danger Zone → Change visibility → Public*. (GitHub Pages ist bei privaten Repos nur mit einem bezahlten Plan möglich.)
2. Pages einschalten: *Settings → Pages → Build and deployment → Source: „GitHub Actions“*.
3. Danach veröffentlicht jeder Merge nach `main` die Seite automatisch (Workflow „Veröffentlichen“). Ein Lauf dauert einige Minuten.

## Entwickeln

```bash
npm ci --ignore-scripts      # Abhängigkeiten (ohne native Zusatzpakete)
npm run build                # baut dist/: Seite + Bibliotheken + Modelle (Cache in .cache/models)
npm run serve                # lokal ansehen: http://127.0.0.1:8080/
node tests/unit.mjs          # Schnelltests der Hilfsfunktionen
node tests/e2e.mjs           # echter Browser-Test mit deutscher Testaufnahme (braucht den Build)
```

Hinter einem Proxy braucht der Build `NODE_USE_ENV_PROXY=1`.

### Aufbau

| Pfad | Inhalt |
|---|---|
| `site/index.html`, `site/styles.css` | Oberfläche (Assistent: Dateien → Umwandeln → Ergebnis) |
| `site/app.js` | Steuerung: Warteschlange, Fortschritt, Ergebnisansicht, Downloads |
| `site/worker.js` | Hintergrund-Thread: Whisper, Sprecher-Erkennung |
| `site/core.js` | Reine Logik: Audio teilen, Filter, SRT/TXT, Stimmen gruppieren |
| `scripts/models.json` | Welche Modelldateien in welcher festen Version ausgeliefert werden |
| `scripts/build.mjs` | Baut `dist/`, lädt und prüft Modelle, bricht bei > 1 GB ab |
| `tests/` | Schnelltests, Browser-Test, Testaufnahmen (zwei Computerstimmen) |
| `.github/workflows/` | Tests bei jedem Push, Veröffentlichung bei `main` |

## Verwendete Modelle

| Modell | Zweck | Lizenz |
|---|---|---|
| Whisper small / base (onnx-community) | Spracherkennung | MIT |
| pyannote segmentation-3.0 (onnx-community) | Sprecherwechsel finden | MIT |
| WeSpeaker ResNet34-LM (onnx-community) | Stimmen wiedererkennen | CC BY 4.0 (Namensnennung auf der Seite) |

### Download-Größen beim ersten Besuch (danach im Browser gespeichert)

| Qualität | Grafikkarte (fp16-Encoder + q8-Decoder) | Prozessor (q8-Encoder + q8-Decoder) |
|---|---|---|
| Ausgewogen (small) | 177 + 157 MB | 92 + 157 MB |
| Schnell (base) | 41 + 54 MB | 23 + 54 MB |
| Rechenmodul (ONNX Runtime WASM), immer | 27 MB | 27 MB |
| Sprecher-Erkennung (nur wenn eingeschaltet) | 6 + 27 MB | 6 + 27 MB |

Ausgeliefert werden alle Varianten (zusammen ca. 610 MB von erlaubten 1 GB); jeder Browser lädt nur, was er braucht.
