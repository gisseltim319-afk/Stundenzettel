# Stundenzettel

Einfacher Stundenzettel als Web-App: Adresse, Stunden, Materialkosten
eintippen, Stundenlohn einmal einstellen – die Gesamtsumme wird live
berechnet. Jeder Monat hat eigene Werte. „Als PDF erstellen“ erzeugt eine
echte PDF-Datei und legt sie dauerhaft in einer Historie ab.

Läuft komplett im Browser: kein Server, keine Anmeldung. Stammdaten
(Adressliste, Werte je Monat) liegen in `localStorage`, Fotos von
Belegen sowie die erzeugten PDFs in IndexedDB (beides deutlich größer als
das 5-10-MB-Kontingent von localStorage erlauben würde). Alles bleibt nur
auf dem jeweiligen Handy/Browser – Löschen der Website-Daten oder ein
anderes Gerät bedeutet einen leeren Stand.

## Benutzen

1. Seite öffnen, oben den Monat auswählen und den Stundenlohn eintragen
   (wird für neue Monate automatisch vom letzten Monat übernommen).
2. Pro Adresse Stunden und Materialkosten eintippen – direkt oder über den
   „+“-Knopf, der einen Wert zum bestehenden dazurechnet (z. B. übers
   Monat verteilt nach jedem Arbeitstag). Gesamt pro Zeile und die
   Gesamtsumme unten aktualisieren sich sofort.
3. Über „+ Beleg (Foto/Datei)“ Fotos von Rechnungen/Kassenzetteln zur
   jeweiligen Adresse hinzufügen (Kamera oder Dateiauswahl, mehrere
   möglich). Werden automatisch verkleinert und landen später mit im PDF.
4. Neue Adresse über das Feld unter der Liste hinzufügen, per „Löschen“
   wieder entfernen (fragt zur Sicherheit mit Ja/Nein nach).
5. **Als PDF erstellen** baut die PDF-Datei (Tabelle + Belege als eigene
   Seite), öffnet sie in einem neuen Tab (von dort drucken/teilen/sichern)
   und legt sie dauerhaft in der Historie ab – auch nach späteren
   Korrekturen bleibt diese Version unverändert abrufbar.
6. **Zurücksetzen** setzt Stunden, Materialkosten und Belege nur des
   gerade angezeigten Monats auf 0 (fragt mit Ja/Nein nach), andere Monate
   bleiben unberührt.
7. **Historie** (unten) listet alle bislang erstellten PDFs, neueste
   zuerst, mit Monat, Zeitpunkt und Gesamtsumme – Klick öffnet die
   jeweilige PDF erneut.

## Auf dem Handy installieren

Safari/Chrome: Seite öffnen → Teilen-Symbol bzw. Menü → **Zum
Home-Bildschirm hinzufügen**. Die App startet dann wie eine normale App ohne
Browser-Leiste und funktioniert dank Service Worker auch offline (nach dem
ersten Laden).

## Deployment (GitHub Pages, kostenlos)

1. Auf GitHub im Repository zu **Settings → Pages**.
2. Unter **Source** „Deploy from a branch“ wählen, Branch `main` und Ordner
   `/ (root)` einstellen, **Save**.
3. Nach ein bis zwei Minuten ist die Seite unter
   `https://<dein-github-name>.github.io/<repo-name>/` erreichbar.

Kein Build-Schritt nötig – es sind reine statische Dateien plus die
mitgelieferte PDF-Bibliothek (`jspdf.umd.min.js`, MIT-lizenziert, lokal statt
per CDN eingebunden, damit die App offline funktioniert).

## Projektstruktur

```
index.html          Seitenstruktur + Formularvorlage für eine Adresszeile
style.css            Design (hell/dunkel automatisch, manuell umschaltbar)
app.js               Ganze Logik: Laden/Speichern, Monatstrennung inkl.
                     Migration alter Daten, Belege (IndexedDB), PDF-Erzeugung
                     (jsPDF) + Archiv, Historie
sw.js                Service Worker: Network-first für Updates, Offline-
                     Fallback aus dem Cache
manifest.json        PWA-Metadaten fürs Installieren auf dem Home-Bildschirm
jspdf.umd.min.js     PDF-Bibliothek (https://github.com/parallax/jsPDF, MIT)
icon-*.png           App-Icons
```
