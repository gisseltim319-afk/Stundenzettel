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

  /** "2026-08" -> "August 2026", für Titel/Historie. */
  function monatLabel(monatWert) {
    var teile = monatWert.split("-");
    var jahr = Number(teile[0]);
    var monatIndex = Number(teile[1]) - 1;
    return new Date(jahr, monatIndex, 1).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Zeigt statt eines nativen confirm() (das manche installierten
   * PWA-Browser lautlos ignorieren, sodass gar nichts passiert) eine
   * eigene Ja/Nein-Zeile: Klick auf "trigger" blendet ihn aus und die
   * Bestätigungszeile ein, "Ja" führt die Aktion aus, "Nein" bricht ab -
   * beides blendet danach wieder zum Ausgangszustand zurück.
   */
  function mitJaNeinBestaetigung(trigger, bestaetigungsZeile, aktion) {
    var jaBtn = bestaetigungsZeile.querySelector(".bestaetigung-ja");
    var neinBtn = bestaetigungsZeile.querySelector(".bestaetigung-nein");

    function abbrechen() {
      bestaetigungsZeile.hidden = true;
      trigger.hidden = false;
    }

    trigger.addEventListener("click", function () {
      trigger.hidden = true;
      bestaetigungsZeile.hidden = false;
    });
    jaBtn.addEventListener("click", function () {
      abbrechen();
      aktion();
    });
    neinBtn.addEventListener("click", abbrechen);
  }

  /**
   * Verdrahtet den "+"-Knopf eines Feldes (Stunden oder Materialkosten):
   * Klick blendet ein kleines Eingabefeld ein, Enter/OK addiert die dort
   * eingegebene Zahl zum bestehenden Wert - so lassen sich Werte übers
   * Monat verteilt nachtragen, ohne selbst rechnen zu müssen.
   */
  function verdrahteHinzufuegenKnopf(eintrag, feldName, stammInput, knoten, praefix) {
    var plusBtn = knoten.querySelector("." + praefix + "-plus-btn");
    var hinzuZeile = knoten.querySelector("." + praefix + "-hinzufuegen-zeile");
    var hinzuInput = knoten.querySelector("." + praefix + "-hinzufuegen-input");
    var hinzuOkBtn = knoten.querySelector("." + praefix + "-hinzufuegen-ok");

    function anwenden() {
      var hinzu = zahl(hinzuInput.value);
      if (hinzu > 0) {
        var neu = Math.round((zahl(eintrag[feldName]) + hinzu) * 100) / 100;
        eintrag[feldName] = String(neu);
        stammInput.value = eintrag[feldName];
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

  // Belege (Fotos von Rechnungen/Kassenzetteln) + PDF-Archiv --------------
  // Beides liegt in IndexedDB statt localStorage, weil Fotos/PDFs schnell
  // mehrere MB groß sind und localStorage-Kontingente typischerweise nur
  // 5-10 MB erlauben. Jeder Beleg gehört zu genau einer Adresse UND einem
  // Monat. Ein In-Memory-Cache (Monat -> Adresse-ID -> Belege) hält alles
  // vor, damit Anzeige/PDF-Erzeugung wie der Rest der App synchron bleiben.
  var BELEGE_DB_NAME = "stundenzettel-belege";
  var BELEGE_STORE = "belege";
  var PDF_ARCHIV_STORE = "pdf_archiv";
  var DB_VERSION = 2;
  var belegeCache = {};

  function belegeDbOeffnen() {
    return new Promise(function (resolve, reject) {
      var anfrage = indexedDB.open(BELEGE_DB_NAME, DB_VERSION);
      anfrage.onupgradeneeded = function () {
        var db = anfrage.result;
        if (!db.objectStoreNames.contains(BELEGE_STORE)) {
          var store = db.createObjectStore(BELEGE_STORE, { keyPath: "id" });
          store.createIndex("adresseId", "adresseId", { unique: false });
        }
        if (!db.objectStoreNames.contains(PDF_ARCHIV_STORE)) {
          db.createObjectStore(PDF_ARCHIV_STORE, { keyPath: "id" });
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

  async function belegHinzufuegen(adresseId, monat, dateiname, datenUrl) {
    var db = await belegeDbOeffnen();
    var eintrag = {
      id: erzeugeId(),
      adresseId: adresseId,
      monat: monat,
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

  /** Belege aus einer Version vor der Monats-Trennung haben noch kein
   *  "monat"-Feld - die werden dem Migrations-Zielmonat zugeordnet. */
  async function migriereBelegeOhneMonat(zielMonat) {
    var alle = await alleBelege();
    var ohneMonat = alle.filter(function (b) {
      return !b.monat;
    });
    if (ohneMonat.length === 0) return;
    var db = await belegeDbOeffnen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(BELEGE_STORE, "readwrite");
      var store = tx.objectStore(BELEGE_STORE);
      ohneMonat.forEach(function (b) {
        b.monat = zielMonat;
        store.put(b);
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
    var neu = {};
    alle.forEach(function (beleg) {
      if (!beleg.monat) return;
      if (!neu[beleg.monat]) neu[beleg.monat] = {};
      if (!neu[beleg.monat][beleg.adresseId]) neu[beleg.monat][beleg.adresseId] = [];
      neu[beleg.monat][beleg.adresseId].push(beleg);
    });
    belegeCache = neu;
  }

  function belegeFuer(monat, adresseId) {
    return (belegeCache[monat] && belegeCache[monat][adresseId]) || [];
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

  function belegeVorschauRendern(container, adresseId, monat) {
    var belege = belegeFuer(monat, adresseId);
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
            belegeCache[monat][adresseId] = (belegeCache[monat][adresseId] || []).filter(function (b) {
              return b.id !== beleg.id;
            });
            belegeVorschauRendern(container, adresseId, monat);
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

  async function belegHochladen(adresseId, monat, datei, vorschauEl, labelSpan) {
    var urText = labelSpan.textContent;
    labelSpan.textContent = "Wird verarbeitet …";
    try {
      var datenUrl = await bildVerkleinern(datei, 1600, 0.75);
      var eintrag = await belegHinzufuegen(adresseId, monat, datei.name, datenUrl);
      if (!belegeCache[monat]) belegeCache[monat] = {};
      if (!belegeCache[monat][adresseId]) belegeCache[monat][adresseId] = [];
      belegeCache[monat][adresseId].push(eintrag);
      belegeVorschauRendern(vorschauEl, adresseId, monat);
      aktualisiereAnzeige();
    } catch (fehler) {
      console.warn("Beleg konnte nicht gespeichert werden.", fehler);
      zeigeSpeicherFehler();
    } finally {
      labelSpan.textContent = urText;
    }
  }

  /** Löscht Belege einer Adresse über ALLE Monate hinweg (Adresse selbst wird entfernt). */
  async function belegeZuAdresseLoeschen(adresseId) {
    var idsZuLoeschen = [];
    Object.keys(belegeCache).forEach(function (monat) {
      var liste = belegeCache[monat][adresseId];
      if (liste && liste.length > 0) {
        idsZuLoeschen = idsZuLoeschen.concat(
          liste.map(function (b) {
            return b.id;
          })
        );
        delete belegeCache[monat][adresseId];
      }
    });
    try {
      await belegeLoeschenFuerIds(idsZuLoeschen);
    } catch (fehler) {
      console.warn("Belege zur gelöschten Adresse konnten nicht bereinigt werden.", fehler);
    }
  }

  /** Löscht nur die Belege EINES Monats (für den monatsbezogenen Zurücksetzen-Knopf). */
  async function belegeFuerMonatLoeschen(monat) {
    var idsZuLoeschen = [];
    if (belegeCache[monat]) {
      Object.keys(belegeCache[monat]).forEach(function (adresseId) {
        idsZuLoeschen = idsZuLoeschen.concat(
          belegeCache[monat][adresseId].map(function (b) {
            return b.id;
          })
        );
      });
    }
    delete belegeCache[monat];
    try {
      await belegeLoeschenFuerIds(idsZuLoeschen);
    } catch (fehler) {
      console.warn("Belege konnten beim Zurücksetzen nicht gelöscht werden.", fehler);
    }
  }

  /** Speichert ein erzeugtes PDF dauerhaft im Archiv (eigener Eintrag pro
   *  Erstellung, damit spätere Korrekturen ältere Versionen nicht überschreiben). */
  async function archivHinzufuegen(monat, gesamtsumme, blob) {
    var db = await belegeDbOeffnen();
    var eintrag = {
      id: erzeugeId(),
      monat: monat,
      gesamtsumme: gesamtsumme,
      erstellt: new Date().toISOString(),
      blob: blob,
    };
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(PDF_ARCHIV_STORE, "readwrite");
      tx.objectStore(PDF_ARCHIV_STORE).add(eintrag);
      tx.oncomplete = function () {
        resolve(eintrag);
      };
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  }

  async function alleArchivEintraege() {
    var db = await belegeDbOeffnen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(PDF_ARCHIV_STORE, "readonly");
      var anfrage = tx.objectStore(PDF_ARCHIV_STORE).getAll();
      anfrage.onsuccess = function () {
        resolve(anfrage.result);
      };
      anfrage.onerror = function () {
        reject(anfrage.error);
      };
    });
  }

  var pdfArchivCache = []; // neueste zuerst

  async function pdfArchivCacheLaden() {
    var alle = await alleArchivEintraege();
    alle.sort(function (a, b) {
      return b.erstellt.localeCompare(a.erstellt);
    });
    pdfArchivCache = alle;
  }

  function formatiereZeitstempel(isoString) {
    var d = new Date(isoString);
    return (
      d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) +
      ", " +
      d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) +
      " Uhr"
    );
  }

  // Daten: Adressen (Stammliste) + je Monat Stundenlohn/Einträge --------
  function standardDaten() {
    var monat = heutigerMonatWert();
    var eintraege = {};
    var adressen = STANDARD_ADRESSEN.map(function (name) {
      var id = erzeugeId();
      eintraege[id] = { stunden: 0, materialkosten: 0 };
      return { id: id, adresse: name };
    });
    var monate = {};
    monate[monat] = { stundenlohn: 15, eintraege: eintraege };
    return { adressen: adressen, aktuellerMonat: monat, monate: monate };
  }

  /** Erkennt das alte, flache Format (vor der Monats-Trennung): Stunden/
   *  Materialkosten saßen direkt an der Adresse statt in daten.monate. */
  function istAltesFormat(geparst) {
    return (
      geparst &&
      Array.isArray(geparst.adressen) &&
      geparst.adressen.length > 0 &&
      geparst.adressen[0].stunden !== undefined
    );
  }

  function migriereAltesFormat(alt) {
    var monat = alt.zeitraum || heutigerMonatWert();
    var eintraege = {};
    var neueAdressen = alt.adressen.map(function (a) {
      eintraege[a.id] = { stunden: a.stunden || 0, materialkosten: a.materialkosten || 0 };
      return { id: a.id, adresse: a.adresse };
    });
    var monate = {};
    monate[monat] = { stundenlohn: alt.stundenlohn || 15, eintraege: eintraege };
    return { adressen: neueAdressen, aktuellerMonat: monat, monate: monate };
  }

  function ladeDaten() {
    try {
      var roh = localStorage.getItem(SPEICHER_SCHLUESSEL);
      if (!roh) return standardDaten();
      var geparst = JSON.parse(roh);
      if (!geparst || !Array.isArray(geparst.adressen)) return standardDaten();
      if (istAltesFormat(geparst)) return migriereAltesFormat(geparst);
      if (!geparst.monate) geparst.monate = {};
      if (!geparst.aktuellerMonat) geparst.aktuellerMonat = heutigerMonatWert();
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

  /** Stundenlohn des zuletzt bekannten Monats - Vorbelegung für neue Monate,
   *  damit man ihn nicht jedes Mal neu eintippen muss. */
  function letzterBekannterStundenlohn() {
    var monate = Object.keys(daten.monate).sort();
    if (monate.length === 0) return 15;
    return daten.monate[monate[monate.length - 1]].stundenlohn;
  }

  function aktuellerMonatObjekt() {
    var m = daten.aktuellerMonat;
    if (!daten.monate[m]) {
      daten.monate[m] = { stundenlohn: letzterBekannterStundenlohn(), eintraege: {} };
    }
    return daten.monate[m];
  }

  function holeEintrag(adresseId) {
    var monatObj = aktuellerMonatObjekt();
    if (!monatObj.eintraege[adresseId]) {
      monatObj.eintraege[adresseId] = { stunden: 0, materialkosten: 0 };
    }
    return monatObj.eintraege[adresseId];
  }

  var monatEl = document.getElementById("monat");
  var zeitraumAnzeigeEl = document.getElementById("zeitraum-anzeige");
  var stundenlohnEl = document.getElementById("stundenlohn");
  var listeEl = document.getElementById("adressen-liste");
  var leerHinweisEl = document.getElementById("leer-hinweis");
  var vorlageEl = document.getElementById("zeile-vorlage");
  var gesamtsummeEl = document.getElementById("gesamtsumme");
  var historieListeEl = document.getElementById("historie-liste");
  var historieLeerEl = document.getElementById("historie-leer");

  var zeilenKnoten = {}; // id -> { gesamtWert }

  function baueListe() {
    listeEl.innerHTML = "";
    zeilenKnoten = {};
    leerHinweisEl.hidden = daten.adressen.length > 0;
    var monat = daten.aktuellerMonat;

    daten.adressen.forEach(function (adresse) {
      var knoten = vorlageEl.content.firstElementChild.cloneNode(true);
      knoten.querySelector(".adresse-name").textContent = adresse.adresse;

      var eintrag = holeEintrag(adresse.id);
      var stundenInput = knoten.querySelector(".stunden-input");
      var materialInput = knoten.querySelector(".material-input");
      stundenInput.value = eintrag.stunden;
      materialInput.value = eintrag.materialkosten;

      stundenInput.addEventListener("input", function () {
        eintrag.stunden = stundenInput.value;
        speichereDaten();
        aktualisiereAnzeige();
      });
      materialInput.addEventListener("input", function () {
        eintrag.materialkosten = materialInput.value;
        speichereDaten();
        aktualisiereAnzeige();
      });
      verdrahteHinzufuegenKnopf(eintrag, "stunden", stundenInput, knoten, "stunden");
      verdrahteHinzufuegenKnopf(eintrag, "materialkosten", materialInput, knoten, "material");

      var belegeVorschauEl = knoten.querySelector(".belege-vorschau");
      var belegInput = knoten.querySelector(".beleg-input");
      var belegLabelSpan = knoten.querySelector(".beleg-upload-label span");
      belegeVorschauRendern(belegeVorschauEl, adresse.id, monat);
      belegInput.addEventListener("change", function () {
        var dateien = belegInput.files ? Array.prototype.slice.call(belegInput.files) : [];
        belegInput.value = "";
        dateien.forEach(function (datei) {
          belegHochladen(adresse.id, monat, datei, belegeVorschauEl, belegLabelSpan);
        });
      });

      mitJaNeinBestaetigung(knoten.querySelector(".loeschen-btn"), knoten.querySelector(".loeschen-bestaetigung"), function () {
        daten.adressen = daten.adressen.filter(function (a) {
          return a.id !== adresse.id;
        });
        Object.keys(daten.monate).forEach(function (m) {
          delete daten.monate[m].eintraege[adresse.id];
        });
        speichereDaten();
        belegeZuAdresseLoeschen(adresse.id);
        baueListe();
        aktualisiereAnzeige();
      });

      zeilenKnoten[adresse.id] = { gesamtWert: knoten.querySelector(".gesamt-wert") };
      listeEl.appendChild(knoten);
    });
  }

  function historieRendern() {
    historieListeEl.innerHTML = "";
    historieLeerEl.hidden = pdfArchivCache.length > 0;

    pdfArchivCache.forEach(function (eintrag) {
      var li = document.createElement("li");
      li.className = "historie-eintrag";

      var button = document.createElement("button");
      button.type = "button";
      button.className = "historie-button";
      button.innerHTML =
        '<span class="historie-info"><span class="historie-monat">' +
        escapeHtml(monatLabel(eintrag.monat)) +
        '</span><span class="historie-zeit">' +
        escapeHtml(formatiereZeitstempel(eintrag.erstellt)) +
        '</span></span><span class="historie-summe">' +
        euro(eintrag.gesamtsumme) +
        "</span>";
      button.addEventListener("click", function () {
        var url = URL.createObjectURL(eintrag.blob);
        window.open(url, "_blank");
      });

      li.appendChild(button);
      historieListeEl.appendChild(li);
    });
  }

  /** Rechnet Zeilen- und Gesamtsummen neu und hält Druckansicht/Historie
   *  synchron – ohne die Eingabefelder neu zu erzeugen, damit Fokus/Cursor
   *  beim Tippen erhalten bleibt. */
  function aktualisiereAnzeige() {
    var lohn = zahl(stundenlohnEl.value);
    var summe = 0;

    daten.adressen.forEach(function (adresse) {
      var eintrag = holeEintrag(adresse.id);
      var gesamt = zahl(eintrag.stunden) * lohn + zahl(eintrag.materialkosten);
      summe += gesamt;
      var el = zeilenKnoten[adresse.id];
      if (el) el.gesamtWert.textContent = euro(gesamt);
    });

    gesamtsummeEl.textContent = euro(summe);
    zeitraumAnzeigeEl.textContent = zeitraumText(daten.aktuellerMonat);
  }

  /** Baut das PDF für den aktuellen Monat mit jsPDF (Tabelle + Belege als
   *  eigene Seite(n)) und liefert es als Blob zusammen mit der Gesamtsumme,
   *  die zusammen mit dem PDF im Archiv landet. */
  function erzeugePdf() {
    var monat = daten.aktuellerMonat;
    var lohn = zahl(stundenlohnEl.value);
    var zeitraum = zeitraumText(monat);

    var SEITENBREITE = 595.28; // A4 in pt
    var SEITENHOEHE = 841.89;
    var RAND = 50;
    var STUNDEN_X = RAND + 295;
    var MATERIAL_X = RAND + 395;
    var GESAMT_X = SEITENBREITE - RAND;

    var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    var y = RAND;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("Stundenzettel", RAND, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(zeitraum, GESAMT_X, y, { align: "right" });
    y += 8;
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(1.2);
    doc.line(RAND, y, SEITENBREITE - RAND, y);
    y += 16;
    doc.setTextColor(90, 90, 100);
    doc.text("Stundenlohn: " + euro(lohn) + " / Stunde", RAND, y);
    doc.setTextColor(20, 20, 20);
    y += 20;

    doc.setFont("helvetica", "bold");
    doc.text("Adresse", RAND, y);
    doc.text("Stunden", STUNDEN_X, y, { align: "right" });
    doc.text("Material", MATERIAL_X, y, { align: "right" });
    doc.text("Gesamt", GESAMT_X, y, { align: "right" });
    y += 6;
    doc.setLineWidth(0.75);
    doc.setDrawColor(0, 0, 0);
    doc.line(RAND, y, SEITENBREITE - RAND, y);
    y += 16;

    doc.setFont("helvetica", "normal");
    var summe = 0;
    var summeStunden = 0;
    var summeMaterial = 0;
    var belegBloecke = [];
    daten.adressen.forEach(function (adresse) {
      var eintrag = holeEintrag(adresse.id);
      var stunden = zahl(eintrag.stunden);
      var material = zahl(eintrag.materialkosten);
      var gesamt = stunden * lohn + material;
      summe += gesamt;
      summeStunden += stunden;
      summeMaterial += material;

      if (y > SEITENHOEHE - RAND - 20) {
        doc.addPage();
        y = RAND;
      }
      doc.text(adresse.adresse, RAND, y);
      doc.text(stunden.toFixed(2).replace(".", ","), STUNDEN_X, y, { align: "right" });
      doc.text(euro(material), MATERIAL_X, y, { align: "right" });
      doc.text(euro(gesamt), GESAMT_X, y, { align: "right" });
      y += 20;

      var belege = belegeFuer(monat, adresse.id);
      if (belege.length > 0) belegBloecke.push({ adresse: adresse.adresse, belege: belege });
    });

    y += 4;
    doc.setLineWidth(1.2);
    doc.line(RAND, y, SEITENBREITE - RAND, y);
    y += 20;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Gesamtsumme", RAND, y);
    doc.text(summeStunden.toFixed(2).replace(".", ","), STUNDEN_X, y, { align: "right" });
    doc.text(euro(summeMaterial), MATERIAL_X, y, { align: "right" });
    doc.text(euro(summe), GESAMT_X, y, { align: "right" });

    y += 50;
    if (y > SEITENHOEHE - RAND - 30) {
      doc.addPage();
      y = RAND;
    }
    doc.setLineWidth(0.75);
    doc.setDrawColor(100, 100, 100);
    doc.line(RAND, y, RAND + 200, y);
    y += 12;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 90);
    doc.text("Datum, Unterschrift", RAND, y);

    if (belegBloecke.length > 0) {
      doc.addPage();
      y = RAND;
      doc.setTextColor(20, 20, 20);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("Belege", RAND, y);
      y += 24;

      belegBloecke.forEach(function (block) {
        if (y > SEITENHOEHE - RAND - 30) {
          doc.addPage();
          y = RAND;
        }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(block.adresse, RAND, y);
        y += 14;

        block.belege.forEach(function (beleg) {
          var props = doc.getImageProperties(beleg.datenUrl);
          var maxBreite = SEITENBREITE - RAND * 2;
          var maxHoehe = 480;
          var breite = maxBreite;
          var hoehe = breite / (props.width / props.height);
          if (hoehe > maxHoehe) {
            hoehe = maxHoehe;
            breite = hoehe * (props.width / props.height);
          }
          if (y + hoehe > SEITENHOEHE - RAND) {
            doc.addPage();
            y = RAND;
          }
          doc.addImage(beleg.datenUrl, "JPEG", RAND, y, breite, hoehe);
          y += hoehe + 12;
        });
        y += 6;
      });
    }

    return { blob: doc.output("blob"), gesamtsumme: summe };
  }

  function monatWechseln() {
    daten.aktuellerMonat = monatEl.value;
    var monatObj = aktuellerMonatObjekt(); // legt bei Bedarf einen neuen Monat an
    speichereDaten();
    stundenlohnEl.value = monatObj.stundenlohn;
    baueListe();
    aktualisiereAnzeige();
  }

  monatEl.addEventListener("input", monatWechseln);

  stundenlohnEl.addEventListener("input", function () {
    aktuellerMonatObjekt().stundenlohn = stundenlohnEl.value;
    speichereDaten();
    aktualisiereAnzeige();
  });

  document.getElementById("adresse-hinzufuegen-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var eingabe = document.getElementById("neue-adresse");
    var name = eingabe.value.trim();
    if (!name) return;
    daten.adressen.push({ id: erzeugeId(), adresse: name });
    speichereDaten();
    eingabe.value = "";
    baueListe();
    aktualisiereAnzeige();
  });

  mitJaNeinBestaetigung(
    document.getElementById("zuruecksetzen-btn"),
    document.getElementById("zuruecksetzen-bestaetigung"),
    function () {
      var monatObj = aktuellerMonatObjekt();
      Object.keys(monatObj.eintraege).forEach(function (id) {
        monatObj.eintraege[id].stunden = 0;
        monatObj.eintraege[id].materialkosten = 0;
      });
      speichereDaten();
      belegeFuerMonatLoeschen(daten.aktuellerMonat).catch(function (fehler) {
        console.warn("Zurücksetzen der Belege fehlgeschlagen.", fehler);
      });
      baueListe();
      aktualisiereAnzeige();
    }
  );

  var druckenBtn = document.getElementById("drucken-btn");
  druckenBtn.addEventListener("click", function () {
    var urText = druckenBtn.textContent;
    druckenBtn.disabled = true;
    druckenBtn.textContent = "Wird erstellt …";
    Promise.resolve()
      .then(function () {
        var ergebnis = erzeugePdf();
        return archivHinzufuegen(daten.aktuellerMonat, ergebnis.gesamtsumme, ergebnis.blob);
      })
      .then(function (eintrag) {
        pdfArchivCache.unshift(eintrag);
        historieRendern();
        window.open(URL.createObjectURL(eintrag.blob), "_blank");
      })
      .catch(function (fehler) {
        console.warn("PDF konnte nicht erstellt werden.", fehler);
        zeigeSpeicherFehler();
      })
      .finally(function () {
        druckenBtn.disabled = false;
        druckenBtn.textContent = urText;
      });
  });

  monatEl.value = daten.aktuellerMonat;
  stundenlohnEl.value = aktuellerMonatObjekt().stundenlohn;
  speichereDaten();
  baueListe();
  aktualisiereAnzeige();

  // Belege/PDF-Archiv kommen aus IndexedDB (asynchron) nach, damit der
  // erste Render nicht darauf warten muss - bauen Liste/Historie kurz
  // danach mit den geladenen Daten neu auf. Erst eventuelle alte Belege
  // ohne Monatszuordnung dem aktuellen (migrierten) Monat zuordnen.
  migriereBelegeOhneMonat(daten.aktuellerMonat)
    .catch(function (fehler) {
      console.warn("Alte Belege konnten nicht migriert werden.", fehler);
    })
    .then(function () {
      return Promise.all([belegeCacheLaden(), pdfArchivCacheLaden()]);
    })
    .then(function () {
      baueListe();
      aktualisiereAnzeige();
      historieRendern();
    })
    .catch(function (fehler) {
      console.warn("Belege/Archiv konnten nicht geladen werden.", fehler);
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
