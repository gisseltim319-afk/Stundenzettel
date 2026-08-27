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

  // Belege (Fotos von Rechnungen/Kassenzetteln) --------------------------
  // Liegen in IndexedDB statt localStorage, weil Fotos schnell mehrere MB
  // groß sind und localStorage-Kontingente typischerweise nur 5-10 MB
  // erlauben. Jeder Beleg gehört zu genau einer Adresse UND einem Monat.
  // Ein In-Memory-Cache (Monat -> Adresse-ID -> Belege) hält alles vor,
  // damit Anzeige/Druckansicht wie der Rest der App synchron bleiben.
  var BELEGE_DB_NAME = "stundenzettel-belege";
  var BELEGE_STORE = "belege";
  var belegeCache = {};

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

  function monatsSumme(monatWert) {
    var monatObj = daten.monate[monatWert];
    if (!monatObj) return 0;
    var lohn = zahl(monatObj.stundenlohn);
    var summe = 0;
    Object.keys(monatObj.eintraege).forEach(function (id) {
      var e = monatObj.eintraege[id];
      summe += zahl(e.stunden) * lohn + zahl(e.materialkosten);
    });
    return summe;
  }

  var monatEl = document.getElementById("monat");
  var zeitraumAnzeigeEl = document.getElementById("zeitraum-anzeige");
  var stundenlohnEl = document.getElementById("stundenlohn");
  var listeEl = document.getElementById("adressen-liste");
  var leerHinweisEl = document.getElementById("leer-hinweis");
  var vorlageEl = document.getElementById("zeile-vorlage");
  var gesamtsummeEl = document.getElementById("gesamtsumme");
  var druckansichtEl = document.getElementById("druckansicht");
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

      mitBestaetigung(knoten.querySelector(".loeschen-btn"), "Wirklich?", function () {
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

  /** Nur Monate mit tatsächlich erfassten Daten zählen als "erstellt" - ein
   *  Monat, den man nur kurz im Auswahlfeld durchgeblättert hat (ohne etwas
   *  einzutragen), landet sonst als leere 0,00-€-Karteileiche in der Liste. */
  function monatHatDaten(monatWert) {
    var monatObj = daten.monate[monatWert];
    if (!monatObj) return false;
    var hatEintraege = Object.keys(monatObj.eintraege).some(function (id) {
      var e = monatObj.eintraege[id];
      return zahl(e.stunden) > 0 || zahl(e.materialkosten) > 0;
    });
    if (hatEintraege) return true;
    var belegeDesMonats = belegeCache[monatWert] || {};
    return Object.keys(belegeDesMonats).some(function (adresseId) {
      return belegeDesMonats[adresseId].length > 0;
    });
  }

  function historieRendern() {
    var monate = Object.keys(daten.monate)
      .filter(monatHatDaten)
      .sort()
      .reverse();

    historieListeEl.innerHTML = "";
    historieLeerEl.hidden = monate.length > 0;

    monate.forEach(function (m) {
      var istAktuell = m === daten.aktuellerMonat;
      var li = document.createElement("li");
      li.className = "historie-eintrag";

      var button = document.createElement("button");
      button.type = "button";
      button.className = "historie-button" + (istAktuell ? " historie-aktuell" : "");
      button.innerHTML =
        '<span class="historie-monat">' +
        escapeHtml(monatLabel(m)) +
        (istAktuell ? " (aktuell)" : "") +
        '</span><span class="historie-summe">' +
        euro(monatsSumme(m)) +
        "</span>";
      button.addEventListener("click", function () {
        monatEl.value = m;
        monatWechseln();
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
    baueDruckansicht(lohn, summe);
    historieRendern();
  }

  function baueDruckansicht(lohn, summe) {
    var zeitraum = zeitraumText(daten.aktuellerMonat);
    var monat = daten.aktuellerMonat;

    var zeilenHtml = daten.adressen
      .map(function (adresse) {
        var eintrag = holeEintrag(adresse.id);
        var gesamt = zahl(eintrag.stunden) * lohn + zahl(eintrag.materialkosten);
        return (
          "<tr><td>" +
          escapeHtml(adresse.adresse) +
          '</td><td class="num">' +
          zahl(eintrag.stunden).toFixed(2).replace(".", ",") +
          '</td><td class="num">' +
          euro(zahl(eintrag.materialkosten)) +
          '</td><td class="num">' +
          euro(gesamt) +
          "</td></tr>"
        );
      })
      .join("");

    var belegeHtml = daten.adressen
      .map(function (adresse) {
        var belege = belegeFuer(monat, adresse.id);
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
          escapeHtml(adresse.adresse) +
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

  mitBestaetigung(document.getElementById("zuruecksetzen-btn"), "Diesen Monat wirklich auf 0?", function () {
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
  });

  document.getElementById("drucken-btn").addEventListener("click", function () {
    window.print();
  });

  monatEl.value = daten.aktuellerMonat;
  stundenlohnEl.value = aktuellerMonatObjekt().stundenlohn;
  speichereDaten();
  baueListe();
  aktualisiereAnzeige();

  // Belege kommen aus IndexedDB (asynchron) nach, damit der erste Render
  // nicht darauf warten muss - baut Liste/Druckansicht/Historie kurz danach
  // mit den geladenen Miniaturen neu auf. Erst eventuelle alte Belege ohne
  // Monatszuordnung dem aktuellen (migrierten) Monat zuordnen.
  migriereBelegeOhneMonat(daten.aktuellerMonat)
    .catch(function (fehler) {
      console.warn("Alte Belege konnten nicht migriert werden.", fehler);
    })
    .then(belegeCacheLaden)
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
