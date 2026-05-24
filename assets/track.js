window.kradioTrack = function (station, url, page) {
  try {
    var payload = JSON.stringify({ station: station, url: url, page: page });
    var blob = new Blob([payload], { type: "text/plain" });
    navigator.sendBeacon("https://radio.nvisio.workers.dev/api/click", blob);
  } catch (e) { /* analytics never blocks UX */ }
};
