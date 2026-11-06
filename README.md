# Audio zu Text

Eine Website, die Audio- und Videodateien mit [Whisper](https://github.com/openai/whisper) in Text und Untertitel umwandelt – **komplett im Browser**. Keine Datei verlässt das Gerät.

**Adresse (nach dem Einschalten von GitHub Pages):** https://richardmatz21-creator.github.io/Claude-Code/

## Was die Seite kann

- Audio- und Videodateien per Drag & Drop oder Auswahl, auch mehrere auf einmal (Warteschlange)
- Zwei Qualitätsstufen: **Ausgewogen** (Whisper small, Standard) und **Schnell** (Whisper base)
- Sprache standardmäßig Deutsch, umstellbar oder automatisch
- Ergebnis als Text (kopieren oder TXT) und Untertitel (SRT), mehrere Dateien als ZIP
- **Sprecher erkennen** (Schalter): wer spricht wann, Namen umbenennbar, in Text und SRT
- Filter für typische erfundene Whisper-Sätze bei Stille („Untertitel im Auftrag des ZDF …“) und Wiederholungsschleifen
- Nutzt die Grafikkarte (WebGPU mit fp16), sonst den Prozessor mit mehreren Kernen
- Fortschritt mit Restzeit, Abbrechen, Bildschirm bleibt während der Umwandlung an

## Benutzen

Seite in **Chrome oder Edge** öffnen, Dateien hineinziehen, „Umwandeln starten“. Beim allerersten Mal wird das Sprachmodell einmalig geladen und danach im Browser gespeichert (siehe Tabelle unten). Während der Umwandlung den Tab sichtbar lassen.

Mit `?modus=prozessor` an der Adresse lässt sich der Prozessor-Modus erzwingen (zur Fehlersuche).

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
