// Cache-first App-Shell, damit die Seite nach dem ersten Laden auch offline
// (z. B. auf der Baustelle ohne Empfang) startet. Alle Daten liegen ohnehin
// nur in localStorage, nicht auf einem Server – hier geht es nur um die
// statischen Dateien selbst.
var CACHE_NAME = "stundenzettel-cache-v2";
var DATEIEN = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
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
    caches.match(event.request).then(function (treffer) {
      if (treffer) return treffer;

      return fetch(event.request)
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
          return caches.match("./index.html");
        });
    })
  );
});
