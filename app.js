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

  /**
   * Macht aus einem Klick eine Zwei-Schritte-Bestätigung, ohne natives
   * confirm(): manche als installierte App gestartete Browser ignorieren
   * confirm()/prompt() lautlos, sodass gar nichts passiert. Erster Klick
   * "bewaffnet" den Knopf (Text wechselt, class confirm-armiert), zweiter
   * Klick innerhalb von 3 Sekunden führt die Aktion aus; sonst fällt der
   * Knopf von selbst zurück.
   */
  function mitBestaetigung(button, bestaetigungsText, aktion) {
    var urText = button.textContent;
    var armiert = false;
    var timeoutId = null;

    button.addEventListener("click", function () {
      if (armiert) {
        armiert = false;
        clearTimeout(timeoutId);
        button.textContent = urText;
        button.classList.remove("confirm-armiert");
        aktion();
        return;
      }
      armiert = true;
      button.textContent = bestaetigungsText;
      button.classList.add("confirm-armiert");
      timeoutId = setTimeout(function () {
        armiert = false;
        button.textContent = urText;
        button.classList.remove("confirm-armiert");
      }, 3000);
    });
  }

  /**
   * Verdrahtet den "+"-Knopf eines Feldes (Stunden oder Materialkosten):
   * Klick blendet ein kleines Eingabefeld ein, Enter/OK addiert die dort
   * eingegebene Zahl zum bestehenden Wert - so lassen sich Werte übers
   * Monat verteilt nachtragen, ohne selbst rechnen zu müssen.
   */
  function verdrahteHinzufuegenKnopf(zeile, feldName, stammInput, knoten, praefix) {
    var plusBtn = knoten.querySelector("." + praefix + "-plus-btn");
    var hinzuZeile = knoten.querySelector("." + praefix + "-hinzufuegen-zeile");
    var hinzuInput = knoten.querySelector("." + praefix + "-hinzufuegen-input");
    var hinzuOkBtn = knoten.querySelector("." + praefix + "-hinzufuegen-ok");

    function anwenden() {
      var hinzu = zahl(hinzuInput.value);
      if (hinzu > 0) {
        var neu = Math.round((zahl(zeile[feldName]) + hinzu) * 100) / 100;
        zeile[feldName] = String(neu);
        stammInput.value = zeile[feldName];
        speichereDaten();
        aktualisiereAnzeige();
      }
      hinzuInput.value = "";
      hinzuZeile.hidden = true;
    }

    plusBtn.addEventListener("click", function () {
      hinzuZeile.hidden = !hinzuZeile.hidden;
      if (!hinzuZeile.hidden) hinzuInput.focus();
    });
    hinzuOkBtn.addEventListener("click", anwenden);
    hinzuInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        anwenden();
      }
    });
  }

  // Belege (Fotos von Rechnungen/Kassenzetteln) --------------------------
  // Liegen in IndexedDB statt localStorage, weil Fotos schnell mehrere MB
  // groß sind und localStorage-Kontingente typischerweise nur 5-10 MB
  // erlauben. Ein In-Memory-Cache hält die Belege je Adresse-ID vor, damit
  // Anzeige/Druckansicht wie der Rest der App synchron bleiben können.
  var BELEGE_DB_NAME = "stundenzettel-belege";
  var BELEGE_STORE = "belege";
  var belegeCache = {}; // adresseId -> [{id, adresseId, dateiname, datenUrl, erstellt}, ...]

  function belegeDbOeffnen() {
    return new Promise(function (resolve, reject) {
      var anfrage = indexedDB.open(BELEGE_DB_NAME, 1);
      anfrage.onupgradeneeded = function () {
        var db = anfrage.result;
        if (!db.objectStoreNames.contains(BELEGE_STORE)) {
          var store = db.createObjectStore(BELEGE_STORE, { keyPath: "id" });
          store.createIndex("adresseId", "adresseId", { unique: false });
        }
      };
      anfrage.onsuccess = function () {
        resolve(anfrage.result);
      };
      anfrage.onerror = function () {
        reject(anfrage.error);
      };
    });
  }

  async function belegHinzufuegen(adresseId, dateiname, datenUrl) {
    var db = await belegeDbOeffnen();
    var eintrag = {
      id: erzeugeId(),
      adresseId: adresseId,
      dateiname: dateiname,
      datenUrl: datenUrl,
      erstellt: new Date().toISOString(),
    };
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(BELEGE_STORE, "readwrite");
      tx.objectStore(BELEGE_STORE).add(eintrag);
      tx.oncomplete = function () {
        resolve(eintrag);
      };
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  async function alleBelege() {
    var db = await belegeDbOeffnen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(BELEGE_STORE, "readonly");
      var anfrage = tx.objectStore(BELEGE_STORE).getAll();
      anfrage.onsuccess = function () {
        resolve(anfrage.result);
      };
      anfrage.onerror = function () {
        reject(anfrage.error);
      };
    });
  }

  async function belegLoeschen(belegId) {
    var db = await belegeDbOeffnen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(BELEGE_STORE, "readwrite");
      tx.objectStore(BELEGE_STORE).delete(belegId);
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  async function belegeLoeschenFuerIds(belegIds) {
    if (belegIds.length === 0) return;
    var db = await belegeDbOeffnen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(BELEGE_STORE, "readwrite");
      var store = tx.objectStore(BELEGE_STORE);
      belegIds.forEach(function (id) {
        store.delete(id);
      });
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  async function belegeCacheLaden() {
    var alle = await alleBelege();
    var neuerCache = {};
    alle.forEach(function (beleg) {
      if (!neuerCache[beleg.adresseId]) neuerCache[beleg.adresseId] = [];
      neuerCache[beleg.adresseId].push(beleg);
    });
    belegeCache = neuerCache;
  }

  /**
   * Verkleinert/komprimiert ein hochgeladenes Bild (Kamera-Fotos sind oft
   * mehrere MB groß) und liefert es als JPEG-Data-URL zurück.
   * createImageBitmap mit imageOrientation "from-image" berücksichtigt
   * dabei die EXIF-Ausrichtung, damit Hochkant-Fotos nicht quer landen.
   */
  async function bildVerkleinern(datei, maxKante, qualitaet) {
    var bitmap = await createImageBitmap(datei, { imageOrientation: "from-image" });
    try {
      var faktor = Math.min(1, maxKante / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * faktor));
      canvas.height = Math.max(1, Math.round(bitmap.height * faktor));
      var ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", qualitaet);
    } finally {
      bitmap.close();
    }
  }

  function zeigeSpeicherFehler() {
    var hinweis = document.getElementById("speicher-fehler-hinweis");
    if (hinweis) hinweis.hidden = false;
  }

  function belegeVorschauRendern(container, adresseId) {
    var belege = belegeCache[adresseId] || [];
    container.innerHTML = "";
    belege.forEach(function (beleg) {
      var miniatur = document.createElement("div");
      miniatur.className = "beleg-miniatur";

      var img = document.createElement("img");
      img.src = beleg.datenUrl;
      img.alt = beleg.dateiname;
      miniatur.appendChild(img);

      var loeschBtn = document.createElement("button");
      loeschBtn.type = "button";
      loeschBtn.className = "beleg-loeschen";
      loeschBtn.setAttribute("aria-label", "Beleg löschen");
      loeschBtn.textContent = "×";
      loeschBtn.addEventListener("click", function () {
        belegLoeschen(beleg.id)
          .then(function () {
            belegeCache[adresseId] = (belegeCache[adresseId] || []).filter(function (b) {
              return b.id !== beleg.id;
            });
            belegeVorschauRendern(container, adresseId);
            aktualisiereAnzeige();
          })
          .catch(function (fehler) {
            console.warn("Beleg konnte nicht gelöscht werden.", fehler);
            zeigeSpeicherFehler();
          });
      });
      miniatur.appendChild(loeschBtn);

      container.appendChild(miniatur);
    });
  }

  async function belegHochladen(adresseId, datei, vorschauEl, labelSpan) {
    var urText = labelSpan.textContent;
    labelSpan.textContent = "Wird verarbeitet …";
    try {
      var datenUrl = await bildVerkleinern(datei, 1600, 0.75);
      var eintrag = await belegHinzufuegen(adresseId, datei.name, datenUrl);
      if (!belegeCache[adresseId]) belegeCache[adresseId] = [];
      belegeCache[adresseId].push(eintrag);
      belegeVorschauRendern(vorschauEl, adresseId);
      aktualisiereAnzeige();
    } catch (fehler) {
      console.warn("Beleg konnte nicht gespeichert werden.", fehler);
      zeigeSpeicherFehler();
    } finally {
      labelSpan.textContent = urText;
    }
  }

  async function belegeAlleLoeschen() {
    belegeCache = {};
    var db = await belegeDbOeffnen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(BELEGE_STORE, "readwrite");
      tx.objectStore(BELEGE_STORE).clear();
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  async function belegeZuAdresseLoeschen(adresseId) {
    var belege = belegeCache[adresseId] || [];
    delete belegeCache[adresseId];
    try {
      await belegeLoeschenFuerIds(belege.map(function (b) { return b.id; }));
    } catch (fehler) {
      console.warn("Belege zur gelöschten Adresse konnten nicht bereinigt werden.", fehler);
    }
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

  function speichereDaten() {
    try {
      localStorage.setItem(SPEICHER_SCHLUESSEL, JSON.stringify(daten));
    } catch (fehler) {
      console.warn("Daten konnten nicht gespeichert werden.", fehler);
      zeigeSpeicherFehler();
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
      verdrahteHinzufuegenKnopf(zeile, "stunden", stundenInput, knoten, "stunden");
      verdrahteHinzufuegenKnopf(zeile, "materialkosten", materialInput, knoten, "material");

      var belegeVorschauEl = knoten.querySelector(".belege-vorschau");
      var belegInput = knoten.querySelector(".beleg-input");
      var belegLabelSpan = knoten.querySelector(".beleg-upload-label span");
      belegeVorschauRendern(belegeVorschauEl, zeile.id);
      belegInput.addEventListener("change", function () {
        var dateien = belegInput.files ? Array.prototype.slice.call(belegInput.files) : [];
        belegInput.value = "";
        dateien.forEach(function (datei) {
          belegHochladen(zeile.id, datei, belegeVorschauEl, belegLabelSpan);
        });
      });

      mitBestaetigung(knoten.querySelector(".loeschen-btn"), "Wirklich?", function () {
        daten.adressen = daten.adressen.filter(function (z) {
          return z.id !== zeile.id;
        });
        speichereDaten();
        belegeZuAdresseLoeschen(zeile.id);
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

    var belegeHtml = daten.adressen
      .map(function (zeile) {
        var belege = belegeCache[zeile.id] || [];
        if (belege.length === 0) return "";
        var bilder = belege
          .map(function (beleg) {
            return (
              '<img class="druck-beleg-bild" src="' + beleg.datenUrl + '" alt="' + escapeHtml(beleg.dateiname) + '">'
            );
          })
          .join("");
        return (
          '<div class="druck-beleg-block"><p class="druck-beleg-adresse">' +
          escapeHtml(zeile.adresse) +
          "</p>" +
          bilder +
          "</div>"
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
      '<div class="unterschrift-linie"></div><span>Datum, Unterschrift</span></div>' +
      (belegeHtml ? '<div class="druck-belege"><h2>Belege</h2>' + belegeHtml + "</div>" : "");
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

  mitBestaetigung(document.getElementById("zuruecksetzen-btn"), "Wirklich alle auf 0?", function () {
    daten.adressen.forEach(function (z) {
      z.stunden = 0;
      z.materialkosten = 0;
    });
    speichereDaten();
    belegeAlleLoeschen().catch(function (fehler) {
      console.warn("Belege konnten beim Zurücksetzen nicht gelöscht werden.", fehler);
    });
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

  // Belege kommen aus IndexedDB (asynchron) nach, damit der erste Render
  // nicht darauf warten muss - baut Liste/Druckansicht kurz danach mit den
  // geladenen Miniaturen neu auf.
  belegeCacheLaden()
    .then(function () {
      baueListe();
      aktualisiereAnzeige();
    })
    .catch(function (fehler) {
      console.warn("Belege konnten nicht geladen werden.", fehler);
    });

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
