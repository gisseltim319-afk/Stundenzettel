// Network-first App-Shell: bei bestehender Verbindung immer die aktuelle
// Version laden (und den Cache dabei auffrischen), nur ohne Verbindung
// (z. B. auf der Baustelle ohne Empfang) auf die zuletzt geladene Version
// aus dem Cache zurückfallen. Alle Nutzdaten liegen ohnehin nur in
// localStorage, nicht auf einem Server – hier geht es nur um die
// statischen Dateien selbst.
var CACHE_NAME = "stundenzettel-cache-v4";
var DATEIEN = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./jspdf.umd.min.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return cache.addAll(DATEIEN);
  }));
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (namen) {
      return Promise.all(
        namen
          .filter(function (name) {
            return name !== CACHE_NAME;
          })
          .map(function (name) {
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request.url, { cache: "no-store" })
      .then(function (antwort) {
        if (antwort.ok && antwort.type === "basic") {
          var kopie = antwort.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, kopie);
          });
        }
        return antwort;
      })
      .catch(function () {
        return caches.match(event.request).then(function (treffer) {
          return treffer || caches.match("./index.html");
        });
      })
  );
});
