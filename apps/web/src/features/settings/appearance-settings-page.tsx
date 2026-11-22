import { useSyncExternalStore } from "react";

import { Select, SelectItem } from "@/components/ui/select";
import { useTranslation } from "@/i18n/use-translation";
import {
  isThemeChoice,
  setThemeChoice,
  storedThemeChoice,
  subscribeToTheme,
  THEMES,
  type ThemeChoice,
} from "@/app/theme";

import { SettingsPageHeading } from "./settings-page-heading";
import { settingsMessages } from "./settings.messages";

/** The choice shown: the stored one, with "System" standing for empty. */
function shownChoice(): ThemeChoice {
  return storedThemeChoice() ?? "system";
}

export function AppearanceSettingsPage() {
  const { t } = useTranslation();
  // Another tab of this browser may change the theme; follow it.
  useSyncExternalStore(subscribeToTheme, shownChoice, shownChoice);
  const choice = shownChoice();
  const system = t(
    document.documentElement.hasAttribute("data-theme")
      ? settingsMessages.dark
      : settingsMessages.light,
  );

  function choose(value: string) {
    if (!isThemeChoice(value) || value === choice) return;
    setThemeChoice(value);
  }

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <SettingsPageHeading
        description={t(settingsMessages.appearanceDescription)}
        title={t(settingsMessages.appearance)}
      />

      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex flex-col justify-center gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-foreground" id="interface-theme">
              {t(settingsMessages.interfaceTheme)}
            </p>
            <p
              className="text-sm text-muted-foreground"
              id="interface-theme-hint"
            >
              {t(settingsMessages.interfaceThemeHint, { current: system })}
            </p>
          </div>
          <Select
            aria-describedby="interface-theme-hint"
            aria-label={t(settingsMessages.interfaceTheme)}
            className="w-full shrink-0 sm:w-44"
            onValueChange={choose}
            value={choice}
          >
            {THEMES.map(({ value }) => (
              <SelectItem key={value} value={value}>
                {t(
                  value === "light"
                    ? settingsMessages.light
                    : value === "dark"
                      ? settingsMessages.dark
                      : settingsMessages.system,
                )}
              </SelectItem>
            ))}
          </Select>
        </div>
      </section>
    </div>
  );
}
