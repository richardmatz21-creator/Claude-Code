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
- Textgerüst (Wunsch Besitzer, Vorlage „Text_Vorlage.docx“ – die Beispieldateien enthalten echte Gesprächsinhalte und kommen NICHT ins Repo): Tab mit Blöcken OFF/OT/Sit (`buildScriptBlocks`: OFF ab 2 s Pause beim Wechsel der Stimme, einstellbar 1,5–8 s; spricht dieselbe Person weiter, erst ab 8 s (oder der größeren Einstellung); ohne Sprecher-Erkennung gilt die gewählte Länge überall; lang/kurz zählt nach der Länge der Abschnitte (Pausen zwischen Abschnitten zählen nicht); OT = Beitrag mit ≥ 8 s Sprache oder einzelner kurzer Beitrag; Sit = mehrere kurze Beiträge von ≥ 2 Stimmen nacheinander, eine kurze Frage („?“) mit ihrer Antwort – auch wenn die Antwort lang ist –, und ein Stimmwechsel ohne Pause (< 0,3 s) zwischen einem langen und einem kurzen Beitrag), Pausen werden an der Sprach-Zeitleiste der Sprecher-Erkennung gemessen (erkennt Stimmen auch unter Musik; ohne sie an der Lautstärke; Whisper-Grenzen liegen oft daneben – Sprachbereiche, die nur knapp in einen längeren Abschnitt ragen, zählen nicht, und steckt eine lange Pause im Abschnitt – je Seite gemessen mit der Schwelle für den Nachbarn (dieselbe Person 8 s, sonst die OFF-Länge) –, gehört Sprache an seinem Rand, die ohne Pause in den Nachbar-Abschnitt weiterläuft, zum Nachbarn – außer es ist der Hauptteil seiner Sprache), ein Sit enthält höchstens einen langen Beitrag, englische Liedtexte (nur bei Einstellung Deutsch, ≥ 2 Abschnitte hintereinander mit deutlich mehr englischen als deutschen Wörtern; „i“/„is“ zählen wegen Dialekt nicht als Englisch) und Abschnitte ohne erkannte Stimme zählen nicht als Sprache, ihr Text bleibt als Hinweis am Block sichtbar und kommt beim Umstellen eines leeren OFF-Blocks auf OT/Sit zurück, ein kurzer Einwurf (keine Frage; Einwürfe derselben Stimme bis 8 s auseinander zählen zusammen) einer zweiten Stimme („Ja.“) nach einem kurzen Block macht daraus ein Sit, nach einem langen OT (≥ 8 s) fällt er weg und das OT bleibt – ob die Person danach weiterspricht oder ein OFF kommt, misst sich an ihrer eigenen Pause; englische Liedtexte werden vor dem Zuschneiden erkannt und gelten nicht als dieselbe Person; Kürzung `shortenText` (erste 3 … Schlagwort-Gruppen … letzte 3, „…“ nur wo etwas fehlt, bis 10 Wörter ganz, Regler mit 5 Stufen für Anzahl und Länge der Gruppen, Standard „stark wie in den Beispielen“; Testtexte immer frei erfinden – nie Inhalte aus Kundendateien), Word-Export `scriptDocxFiles` (Querformat, Spalten 846/8788/3261, Titelzeile grün 8DD873, Arial 11, OFF fett, Timecode rechts). Keine Fragesteller-Funktion (laut Besitzer kommen Fragen im Material nicht vor).
- Nichts wird gespeichert (Entscheidung Besitzer): Warnung beim Schließen, solange Ergebnisse/Korrekturen nicht heruntergeladen sind.
- Nicht enthalten: Mikrofon-Aufnahme, Word-Datei für das reine Transkript (dafür TXT/SRT; Word nur beim Textgerüst), Handy-Optimierung.

## Gelernt aus dem Vergleich mit echten Textgerüsten (Korrekturen des Besitzers, dauerhaft)
- Vergleich „automatisch vs. richtig“ (Nov. 2026, eine Folge mit Musik und Außendreh) ergab diese Regeln, sie gelten weiter: OFF schon ab 2 s; Pausen unter Musik/Atmo zählen (Sprach-Zeitleiste statt Lautstärke); Fragen kommen nur in Sits vor (kurze Frage < 8 s + direkt folgende Antwort ohne OFF dazwischen = Sit; eine kurze Frage ist kein Einwurf); Stimmwechsel ohne Pause zwischen einem langen und einem kurzen Beitrag = Sit; englische Songtexte gehören ins OFF; zu viele Sprecher durch kurze Schnipsel vermeiden (Sprecher-Gruppierung: Schwelle 0,4, Gruppen unter 2 s Sprache kommen zur ähnlichsten größeren).
- Pausen zwischen Beiträgen werden an den auf die Zeitleiste zugeschnittenen Whisper-Grenzen gemessen, nicht als längste Lücke der reinen Zeitleiste: Diese füllt kurze Satzpausen auf (Nachhall, Musik), und der Vergleich passte damit klar schlechter (9 statt 4 Abweichungen bei 38 Blöcken). Nicht „verbessern“, ohne erneut gegen ein echtes Textgerüst zu prüfen.
- Zweiter Vergleich (Nov. 2026, 5 weitere Folgen): Die Bearbeiter setzen OFFs viel sparsamer, eine Person, die kurz absetzt, wird nicht geteilt. Regel daher: OFF ab 2 s nur beim Stimmwechsel, bei derselben Person ab 8 s (Abweichungen 95 → 60 bei 158 Blöcken in 5 Folgen). Die Bearbeiter-Stile schwanken je Folge (eine Folge passt am besten mit 2 s, andere mit 7–8 s) – darum bleibt die OFF-Länge beim Stimmwechsel einstellbar (für dieselbe Person gilt das Größere aus Einstellung und 8 s). Geprüft und verworfen: Liedtext zwischen Sätzen derselben Person erzwingt ein OFF (passte schlechter). Ohne Sprecher-Erkennung passt die gewählte Länge für alles klar besser als 8 s (61 statt 131 Abweichungen). Folgen, deren Textgerüst Szenen umstellt oder nur einen Teil des Materials nutzt, taugen nicht für den Block-Vergleich.
- Kürzung bleibt „erste 3 … Schlagwörter … letzte 3“ (Entscheidung Besitzer), auch wenn das Vorlage-Textgerüst ungekürzt ist.
- Nicht per Regel lösbar (bleibt Handarbeit): gemeinsame Interviews („OT Anna & Ben“), Namen der Sprecher, Hörfehler von Whisper bei Dialekt, die genaue Grenze zwischen Sit und anschließendem OT innerhalb einer langen Antwort.
- Für solche Vergleiche gibt es den Analyse-Modus `…/?debug` (Rohdaten in `window.__azt`). Kundendateien und Auswertungen bleiben im Scratchpad der Session, nie im Repo.

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
