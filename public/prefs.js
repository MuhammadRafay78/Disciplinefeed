// Loaded in <head>, before the page paints, so a saved theme or text size never flashes in late.
// app.js owns changing these; this only re-applies what was saved on this device.
(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem("df:prefs") || "{}");
    var root = document.documentElement;
    if (prefs.theme === "light" || prefs.theme === "dark") root.dataset.theme = prefs.theme;
    if (prefs.font === "sans") root.dataset.readerFont = "sans";
    if (typeof prefs.textSize === "number") root.style.setProperty("--reader-font-size", prefs.textSize + "px");
  } catch (e) {
    // Storage can be unavailable (private mode, blocked site data); defaults apply.
  }
})();
