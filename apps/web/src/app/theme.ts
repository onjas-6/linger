/**
 * The interface theme: light, dark, or whatever the operating system uses.
 *
 * The choice is kept per browser, exactly like the language choice: the
 * sign-in page and the desktop shell render before any account is known.
 * No stored value means the person has not chosen, so the interface
 * follows the system (`prefers-color-scheme`) instead.
 *
 * The theme is applied as `data-theme="dark"` on the document element.
 * `restoreTheme()` runs before the first paint, so dark mode never
 * flashes by in light first.
 */

export const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export type ThemeChoice = (typeof THEMES)[number]["value"];

export const THEME_STORAGE_KEY = "linger.theme";

const listeners = new Set<() => void>();

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEMES.some((theme) => theme.value === value);
}

/** The theme the person chose on this device; undefined before any choice. */
export function storedThemeChoice(): ThemeChoice | undefined {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** The theme on screen right now: the stored choice, or the system's. */
export function currentTheme(): Exclude<ThemeChoice, "system"> {
  return resolveTheme(storedThemeChoice());
}

function resolveTheme(
  choice: ThemeChoice | undefined,
): Exclude<ThemeChoice, "system"> {
  if (choice && choice !== "system") return choice;
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

/** Applies `theme` to the document; a no-op where there is no document. */
function showTheme(theme: Exclude<ThemeChoice, "system">) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Switches the interface to `choice` and remembers it. The system choice
 * follows the operating system from then on, including while the app is
 * open.
 */
export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The switch still holds for this session without saved preferences.
  }
  applyThemeChoice(choice);
}

function applyThemeChoice(choice: ThemeChoice | undefined) {
  showTheme(resolveTheme(choice));
  for (const listener of listeners) listener();
}

/**
 * Shows the remembered theme before the first paint. Afterward, the
 * system choice keeps following the operating system until the person
 * picks a theme of their own.
 */
export function restoreTheme() {
  if (typeof window === "undefined") return;
  const stored = storedThemeChoice();
  applyThemeChoice(stored);
  if (stored && stored !== "system") return;
  // The person has not pinned a theme: follow the system as it changes.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (storedThemeChoice()) return;
      applyThemeChoice("system");
    });
  // Another tab of this browser changed the theme: follow it.
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyThemeChoice(storedThemeChoice() ?? "system");
  });
}

/** Puts the interface back to light between tests. */
export function resetThemeForTest() {
  if (typeof document !== "undefined")
    document.documentElement.removeAttribute("data-theme");
  for (const listener of listeners) listener();
}
