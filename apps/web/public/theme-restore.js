/* Applied before the first paint so dark mode never flashes by in light: the
   theme switcher in main.tsx reads the same key and keeps it in step. */
try {
  var stored = window.localStorage.getItem("linger.theme");
  var dark =
    stored === "dark" ||
    (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
} catch {
  /* A locked-down storage leaves the interface in light; that is fine. */
}
