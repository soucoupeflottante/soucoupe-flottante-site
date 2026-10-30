/* Tally: small, cookieless statistics. Counts only, no identifiers, nothing typed is sent. */
(function () {
  var s = document.currentScript;
  var app = (s && s.getAttribute("data-app")) || "site";
  var nav = navigator;
  if (nav.doNotTrack === "1" || window.doNotTrack === "1" || nav.globalPrivacyControl) return;

  var counts = {};
  var total = 0;
  var timer = null;

  function clean(v) {
    return String(v).toLowerCase().replace(/[^a-z0-9:_.\-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  }
  function track(name, n) {
    name = clean(name);
    if (!name) return;
    counts[name] = (counts[name] || 0) + (n || 1);
    total++;
    if (total >= 40) flush();
  }
  function flush() {
    if (!total) return;
    var payload = JSON.stringify({ app: app, events: counts });
    counts = {};
    total = 0;
    try {
      if (nav.sendBeacon && nav.sendBeacon("/tally/hit", new Blob([payload], { type: "application/json" }))) return;
    } catch (e) {}
    try {
      fetch("/tally/hit", { method: "POST", body: payload, headers: { "content-type": "application/json" }, keepalive: true });
    } catch (e) {}
  }

  // Page opening
  var file = location.pathname.split("/").filter(Boolean).pop() || "home";
  track("open");
  track("page:" + file.replace(/\.html?$/, ""));
  var w = window.innerWidth;
  track("device:" + (w < 600 ? "phone" : w < 1024 ? "tablet" : "desktop"));
  var installed = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || nav.standalone;
  track(installed ? "mode:app" : "mode:browser");
  track("theme:" + (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  if (nav.language) track("lang:" + nav.language.slice(0, 2));

  // Clicks
  var ATTRS = ["data-act", "data-tab", "data-go", "data-rate", "data-theme"];
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-ev],[data-act],[data-tab],[data-go],[data-rate],[data-theme]") : null;
    if (!el) return;
    var ev = el.getAttribute("data-ev");
    if (ev) track(ev);
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v && v.length <= 24) track(ATTRS[i].slice(5) + ":" + v);
    }
  }, true);

  // Field changes: only the field name, never the text
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t && t.name) track("edit:" + t.name);
  }, true);

  // Sending: after about 4 seconds, every minute, when hidden, when closing
  setTimeout(flush, 4000);
  timer = setInterval(flush, 60000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });
  addEventListener("pagehide", flush);

  window.__tally = { track: track, flush: flush };
})();
