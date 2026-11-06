# Projektregeln: Audio zu Text

Diese Regeln wurden mit dem Repo-Besitzer abgestimmt. Jede Session hält sich daran.

## Was das Projekt ist
Statische Website auf GitHub Pages (`https://richardmatz21-creator.github.io/Claude-Code/`), die Audio/Video mit Whisper im Browser transkribiert (transformers.js). Nutzung im kleinen Kreis per Link.

## Harte Regeln
- **Kein Server, kein API-Schlüssel.** Alles läuft im Browser des Nutzers.
- **Keine Anfragen an Drittanbieter zur Laufzeit.** Seite, Bibliotheken, WASM-Dateien, Schriften und Modelle kommen von der eigenen github.io-Adresse (kein Hugging Face, kein CDN, keine Google Fonts). Grund: Firmennetze sperren oft huggingface.co; Datenschutz.
- **Modelle nicht ins Git-Repo.** Der Build (GitHub Actions) lädt sie in fester Version herunter und legt sie in die veröffentlichte Seite.
- **Gesamtgröße der veröffentlichten Seite < 1 GB** (Grenze von GitHub Pages). Der Build bricht ab, wenn es mehr wird.
- **Zielgeräte:** schwache Office-Laptops (Windows, Chrome/Edge, eingebaute Grafik, 8–16 GB RAM). WebGPU nutzen, wenn verfügbar und fp16-fähig, sonst WASM auf dem Prozessor. Handy ist kein Ziel.
- **Oberfläche auf Deutsch**, verständlich für Nicht-Techniker.
- **Design:** Assistent mit drei Schritten (Dateien → Umwandeln → Ergebnis), im Ergebnis die Tabs „Text“ und „Untertitel“ (Sprecher-Zeitleiste, umbenennbare Sprecher, Untertitel-Blöcke). Entwurf „C + Untertitel-Tab aus D“.

## Funktionsumfang (Stand Plan)
- Eingabe: Datei-Upload (Drag & Drop/Auswahl), Audio und Video, mehrere Dateien als Warteschlange. Warnung bei sehr großen Dateien.
- Modelle: Whisper „small“ (Standard, „Ausgewogen“) und „base“ („Schnell“). Kein large-v3-turbo.
- Sprache standardmäßig Deutsch, umstellbar, nie übersetzen.
- Filter für erfundene Whisper-Sätze bei Stille (z. B. „Untertitel im Auftrag des ZDF …“, „Untertitel der Amara.org-Community“) und Wiederholungsschleifen.
- Ausgabe: Text kopieren, TXT, SRT, alle als ZIP.
- Sprecher-Erkennung als Schalter (Standard aus), mit Wiedererkennung der Stimmen über die ganze Aufnahme; Anzahl Personen automatisch oder 2–5 wählbar; Sprecher umbenennbar.
- Fortschritt, Restzeit, Abbrechen, Bildschirm bleibt an (Wake Lock), Hinweis „Tab sichtbar lassen“.
- Bearbeiten (Wunsch Besitzer, Design A + C): Text-Ansicht direkt editierbar pro Abschnitt (contenteditable, Abschnitt = Whisper-Segment, damit Zeitstempel erhalten bleiben), ▶ beim aktiven Abschnitt + Strg+Leertaste, Korrektur-Modus Satz für Satz mit Anhören, Suchen & Ersetzen (aktuelle Datei) mit Rückgängig, Original wiederherstellen, leere Abschnitte fallen aus TXT/SRT. Anhören spielt die Originaldatei per Object-URL ab.
- Textgerüst (Wunsch Besitzer, Vorlage „Text_Vorlage.docx“ – die Beispieldateien enthalten echte Gesprächsinhalte und kommen NICHT ins Repo): Tab mit Blöcken OFF/OT/Sit (`buildScriptBlocks`: OFF ab 3 s ohne Sprache, einstellbar; OT = Beitrag ≥ 8 s am Stück oder einzelner kurzer Beitrag; Sit = mehrere kurze Beiträge von ≥ 2 Stimmen nacheinander), Pausen werden an der Lautstärke gemessen (Whisper-Abschnitte sind gepolstert), ein kurzer Einwurf einer zweiten Stimme macht aus dem Block davor ein Sit; Kürzung `shortenText` (erste 3 … Schlagwort-Gruppen … letzte 3, „…“ nur wo etwas fehlt, bis 10 Wörter ganz, Regler mit 5 Stufen für Anzahl und Länge der Gruppen, Standard „stark wie in den Beispielen“; Testtexte immer frei erfinden – nie Inhalte aus Kundendateien), Word-Export `scriptDocxFiles` (Querformat, Spalten 846/8788/3261, Titelzeile grün 8DD873, Arial 11, OFF fett, Timecode rechts). Keine Fragesteller-Funktion (laut Besitzer kommen Fragen im Material nicht vor).
- Nichts wird gespeichert (Entscheidung Besitzer): Warnung beim Schließen, solange Ergebnisse/Korrekturen nicht heruntergeladen sind.
- Nicht enthalten: Mikrofon-Aufnahme, Word-Datei für das reine Transkript (dafür TXT/SRT; Word nur beim Textgerüst), Handy-Optimierung.

## Technische Stolperfallen (schon gelöst, nicht wieder einbauen)
- transformers.js 4.3: `env.localModelPath` muss ein **Pfad** sein (`/Claude-Code/a-…/models/`), keine volle URL – sonst findet es lokale Dateien wie `preprocessor_config.json` nicht.
- ONNX-Runtime-WASM-Dateien explizit über `env.backends.onnx.wasm.wasmPaths` auf `vendor/` setzen, sonst lädt transformers.js sie von jsDelivr.
- Versionierung: Bibliotheken und Modelle liegen unter `a-<hash>/` (Hash aus `models.json` + `package-lock.json`), eigene Dateien bekommen `?v=<Build>`. Platzhalter `__ASSETS__`/`__BUILD__` ersetzt `scripts/build.mjs`. transformers.js speichert Dateien dauerhaft in der Cache API; der Worker löscht Einträge alter `a-…`-Ordner.
- Ladefehler meldet transformers.js als „file was not found locally“ – das ist ein Netzwerkproblem, kein Grafikkarten-Fehler. Die Grafikkarte wird nur nach echten GPU-Fehlern abgeschaltet, und nur bis zum nächsten Build.
- Abbrechen: Jeder Lauf hat eine `runId`; Nachrichten und verspätete Dekodierungen aus alten Läufen werden ignoriert. Der Worker nimmt nur einen Auftrag gleichzeitig.
- GPU-Modus: Encoder `fp16` auf WebGPU, Decoder `q8` auf WASM (die fp16-Encoder haben fp32-Ein-/Ausgänge, das passt). Ohne `shader-f16` → Prozessor-Modus.
- `coi-serviceworker.min.js` muss im Hauptordner liegen (Mehrkern-WASM braucht COOP/COEP, GitHub Pages setzt keine Header). Erster Besuch lädt einmal neu.
- Builds in Claude-Cloud-Sessions brauchen `NODE_USE_ENV_PROXY=1`; Hugging Face liefert große Dateien über `us.aws.cdn.hf.co`.
- Testrechner haben keine fp16-Grafikkarte: automatisch testbar ist nur der Prozessor-Modus.

## Arbeitsablauf
- Arbeiten auf einem `claude/…`-Branch, dann Pull Request nach `main`. Gemergt wird nur nach ausdrücklichem OK des Besitzers.
- `main` wird automatisch über GitHub Actions auf Pages veröffentlicht.
- Vor der Abgabe prüft ein unabhängiger Prüfer-Agent das Ergebnis gegen diese Regeln.
