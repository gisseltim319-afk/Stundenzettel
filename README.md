# Stundenzettel

Einfacher Stundenzettel als Web-App: Adresse, Stunden, Materialkosten
eintippen, Stundenlohn einmal einstellen – die Gesamtsumme wird live
berechnet. Über den normalen Druckdialog direkt ausdrucken oder als PDF
sichern.

Läuft komplett im Browser: kein Server, keine Datenbank, keine Anmeldung.
Alle Eingaben werden nur lokal auf dem jeweiligen Handy/Browser gespeichert
(`localStorage`) – Löschen der Browserdaten oder ein anderes Gerät/Browser
bedeutet einen leeren Stundenzettel.

## Benutzen

1. Seite öffnen, Stundenlohn oben eintragen.
2. Pro Adresse Stunden und Materialkosten eintippen – Gesamt pro Zeile und
   die Gesamtsumme unten aktualisieren sich sofort.
3. Neue Adresse über das Feld unter der Liste hinzufügen, per „Löschen“
   wieder entfernen.
4. **Drucken / als PDF speichern** öffnet den normalen Druckdialog. Dort als
   Ziel entweder einen Drucker wählen oder „Als PDF speichern“ (iOS/Android/
   Desktop bieten das im Druckdialog standardmäßig an).
5. **Zurücksetzen** setzt Stunden und Materialkosten aller Adressen auf 0,
   für die nächste Abrechnungsrunde (die Adressliste selbst bleibt erhalten).

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
   `https://<dein-github-name>.github.io/papa-stundenzettel/` erreichbar.

Kein Build-Schritt nötig – es sind reine statische Dateien
(`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, Icons).

## Projektstruktur

```
index.html      Seitenstruktur + Formularvorlage für eine Adresszeile
style.css       Design (hell/dunkel automatisch) + eigenes Druck-Layout
app.js          Ganze Logik: Laden/Speichern (localStorage), Live-Summen,
                Adressen verwalten, Druckansicht befüllen
sw.js           Service Worker für Offline-Nutzung nach dem ersten Laden
manifest.json   PWA-Metadaten fürs Installieren auf dem Home-Bildschirm
icon-*.png      App-Icons
```
