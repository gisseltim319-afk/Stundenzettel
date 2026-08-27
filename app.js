(function () {
  "use strict";

  var SPEICHER_SCHLUESSEL = "stundenzettel-daten-v1";

  var STANDARD_ADRESSEN = [
    "Körner Hellweg 26",
    "Körner Hellweg 28",
    "Körner Hellweg 30",
    "Warburster Str. 10",
    "Hallesche Str. 71",
    "Hallesche Str. 73",
    "Speyer Str. 11",
  ];

  var EURO = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

  function erzeugeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function heutigerMonatWert() {
    var heute = new Date();
    return heute.getFullYear() + "-" + String(heute.getMonth() + 1).padStart(2, "0");
  }

  function standardDaten() {
    return {
      zeitraum: heutigerMonatWert(),
      stundenlohn: 15,
      adressen: STANDARD_ADRESSEN.map(function (adresse) {
        return { id: erzeugeId(), adresse: adresse, stunden: 0, materialkosten: 0 };
      }),
    };
  }

  /** Tippfehler-tolerant (Komma statt Punkt), negative/ungültige Eingaben werden zu 0. */
  function zahl(wert) {
    var n = Number(String(wert == null ? "" : wert).trim().replace(",", "."));
    return isFinite(n) && n >= 0 ? n : 0;
  }

  function euro(n) {
    return EURO.format(n);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** "2026-08" -> "01.08.2026 – 31.08.2026". Leere/ungültige Werte ergeben "". */
  function zeitraumText(monatWert) {
    if (!monatWert) return "";
    var teile = monatWert.split("-");
    var jahr = Number(teile[0]);
    var monat = Number(teile[1]);
    if (!jahr || !monat) return "";
    var letzterTag = new Date(jahr, monat, 0).getDate();
    var basis = pad2(monat) + "." + jahr;
    return "01." + basis + " – " + pad2(letzterTag) + "." + basis;
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function ladeDaten() {
    try {
      var roh = localStorage.getItem(SPEICHER_SCHLUESSEL);
      if (!roh) return standardDaten();
      var geparst = JSON.parse(roh);
      if (!geparst || !Array.isArray(geparst.adressen)) return standardDaten();
      if (!geparst.zeitraum) geparst.zeitraum = heutigerMonatWert();
      return geparst;
    } catch (fehler) {
      console.warn("Gespeicherte Daten konnten nicht gelesen werden, starte mit Standardliste.", fehler);
      return standardDaten();
    }
  }

  var daten = ladeDaten();
  var speichernFehlerGezeigt = false;

  function speichereDaten() {
    try {
      localStorage.setItem(SPEICHER_SCHLUESSEL, JSON.stringify(daten));
    } catch (fehler) {
      console.warn("Daten konnten nicht gespeichert werden.", fehler);
      if (!speichernFehlerGezeigt) {
        speichernFehlerGezeigt = true;
        alert(
          "Speichern hat nicht geklappt (z. B. privater Modus oder voller Speicher). " +
            "Eingaben bleiben nur bis zum Schließen der Seite erhalten."
        );
      }
    }
  }

  var monatEl = document.getElementById("monat");
  var zeitraumAnzeigeEl = document.getElementById("zeitraum-anzeige");
  var stundenlohnEl = document.getElementById("stundenlohn");
  var listeEl = document.getElementById("adressen-liste");
  var leerHinweisEl = document.getElementById("leer-hinweis");
  var vorlageEl = document.getElementById("zeile-vorlage");
  var gesamtsummeEl = document.getElementById("gesamtsumme");
  var druckansichtEl = document.getElementById("druckansicht");

  var zeilenKnoten = {}; // id -> { gesamtWert }

  function baueListe() {
    listeEl.innerHTML = "";
    zeilenKnoten = {};
    leerHinweisEl.hidden = daten.adressen.length > 0;

    daten.adressen.forEach(function (zeile) {
      var knoten = vorlageEl.content.firstElementChild.cloneNode(true);
      knoten.querySelector(".adresse-name").textContent = zeile.adresse;

      var stundenInput = knoten.querySelector(".stunden-input");
      var materialInput = knoten.querySelector(".material-input");
      stundenInput.value = zeile.stunden;
      materialInput.value = zeile.materialkosten;

      stundenInput.addEventListener("input", function () {
        zeile.stunden = stundenInput.value;
        speichereDaten();
        aktualisiereAnzeige();
      });
      materialInput.addEventListener("input", function () {
        zeile.materialkosten = materialInput.value;
        speichereDaten();
        aktualisiereAnzeige();
      });
      knoten.querySelector(".loeschen-btn").addEventListener("click", function () {
        if (!confirm('"' + zeile.adresse + '" wirklich löschen?')) return;
        daten.adressen = daten.adressen.filter(function (z) {
          return z.id !== zeile.id;
        });
        speichereDaten();
        baueListe();
        aktualisiereAnzeige();
      });

      zeilenKnoten[zeile.id] = { gesamtWert: knoten.querySelector(".gesamt-wert") };
      listeEl.appendChild(knoten);
    });
  }

  /** Rechnet Zeilen- und Gesamtsummen neu und hält die Druckansicht synchron – ohne die
   *  Eingabefelder neu zu erzeugen, damit Fokus/Cursor beim Tippen erhalten bleibt. */
  function aktualisiereAnzeige() {
    var lohn = zahl(stundenlohnEl.value);
    var summe = 0;

    daten.adressen.forEach(function (zeile) {
      var gesamt = zahl(zeile.stunden) * lohn + zahl(zeile.materialkosten);
      summe += gesamt;
      var eintrag = zeilenKnoten[zeile.id];
      if (eintrag) eintrag.gesamtWert.textContent = euro(gesamt);
    });

    gesamtsummeEl.textContent = euro(summe);
    zeitraumAnzeigeEl.textContent = zeitraumText(daten.zeitraum);
    baueDruckansicht(lohn, summe);
  }

  function baueDruckansicht(lohn, summe) {
    var zeitraum = zeitraumText(daten.zeitraum);

    var zeilenHtml = daten.adressen
      .map(function (zeile) {
        var gesamt = zahl(zeile.stunden) * lohn + zahl(zeile.materialkosten);
        return (
          "<tr><td>" +
          escapeHtml(zeile.adresse) +
          '</td><td class="num">' +
          zahl(zeile.stunden).toFixed(2).replace(".", ",") +
          '</td><td class="num">' +
          euro(zahl(zeile.materialkosten)) +
          '</td><td class="num">' +
          euro(gesamt) +
          "</td></tr>"
        );
      })
      .join("");

    druckansichtEl.innerHTML =
      '<div class="druck-kopf"><h1>Stundenzettel</h1><span>' +
      zeitraum +
      '</span></div><p class="druck-lohn">Stundenlohn: ' +
      euro(lohn) +
      ' / Stunde</p><table class="druck-tabelle"><thead><tr><th>Adresse</th>' +
      '<th class="num">Stunden</th><th class="num">Material</th><th class="num">Gesamt</th>' +
      "</tr></thead><tbody>" +
      zeilenHtml +
      '</tbody><tfoot><tr><td colspan="3">Gesamtsumme</td><td class="num">' +
      euro(summe) +
      '</td></tr></tfoot></table><div class="druck-unterschrift">' +
      '<div class="unterschrift-linie"></div><span>Datum, Unterschrift</span></div>';
  }

  monatEl.addEventListener("input", function () {
    daten.zeitraum = monatEl.value;
    speichereDaten();
    aktualisiereAnzeige();
  });

  stundenlohnEl.addEventListener("input", function () {
    daten.stundenlohn = stundenlohnEl.value;
    speichereDaten();
    aktualisiereAnzeige();
  });

  document.getElementById("adresse-hinzufuegen-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var eingabe = document.getElementById("neue-adresse");
    var name = eingabe.value.trim();
    if (!name) return;
    daten.adressen.push({ id: erzeugeId(), adresse: name, stunden: 0, materialkosten: 0 });
    speichereDaten();
    eingabe.value = "";
    baueListe();
    aktualisiereAnzeige();
  });

  document.getElementById("zuruecksetzen-btn").addEventListener("click", function () {
    if (!confirm("Stunden und Materialkosten für alle Adressen auf 0 zurücksetzen?")) return;
    daten.adressen.forEach(function (z) {
      z.stunden = 0;
      z.materialkosten = 0;
    });
    speichereDaten();
    baueListe();
    aktualisiereAnzeige();
  });

  document.getElementById("drucken-btn").addEventListener("click", function () {
    window.print();
  });

  monatEl.value = daten.zeitraum;
  stundenlohnEl.value = daten.stundenlohn;
  baueListe();
  aktualisiereAnzeige();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(function () {
      /* Offline-Unterstützung ist ein Bonus, kein Muss – Fehler hier sind unkritisch. */
    });

    // Übernimmt ein neuer Service Worker (z. B. nach einem Update) die
    // Kontrolle, einmal neu laden - sonst bleibt eine bereits offene Seite/
    // installierte App auf dem alten Stand hängen, bis sie manuell neu
    // gestartet wird.
    var neuGeladenWegenUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (neuGeladenWegenUpdate) return;
      neuGeladenWegenUpdate = true;
      window.location.reload();
    });
  }

  // Design: folgt standardmäßig der Systemeinstellung ("Automatisch"). Wählt
  // jemand explizit Hell/Dunkel, gewinnt das dauerhaft (siehe style.css) –
  // die Grundanwendung passiert schon inline im <head>, hier nur die Anzeige
  // im Auswahlfeld synchronisieren und auf Änderungen reagieren.
  var THEME_SCHLUESSEL = "stundenzettel-theme";
  var themeAuswahlEl = document.getElementById("theme-auswahl");

  function gespeichertesTheme() {
    try {
      return localStorage.getItem(THEME_SCHLUESSEL);
    } catch (fehler) {
      return null;
    }
  }

  themeAuswahlEl.value = gespeichertesTheme() || "system";

  themeAuswahlEl.addEventListener("change", function () {
    var wert = themeAuswahlEl.value;
    try {
      if (wert === "light" || wert === "dark") {
        localStorage.setItem(THEME_SCHLUESSEL, wert);
        document.documentElement.setAttribute("data-theme", wert);
      } else {
        localStorage.removeItem(THEME_SCHLUESSEL);
        document.documentElement.removeAttribute("data-theme");
      }
    } catch (fehler) {
      console.warn("Design konnte nicht gespeichert werden.", fehler);
    }
  });
})();
