import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { restoreTheme, THEME_STORAGE_KEY } from "@/app/theme";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { AppearanceSettingsPage } from "./appearance-settings-page";
import { SettingsLayout } from "./settings-page";

describe("Appearance settings", () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    restoreTheme();
  });

  it("offers Light, Dark and System, with System chosen before any choice", async () => {
    renderAppearanceSettings();
    const select = await screen.findByRole("combobox", { name: "Theme" });
    expect(select).toHaveValue("system");
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("switches to dark without a reload and remembers the choice", async () => {
    renderAppearanceSettings();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    await chooseTheme("Theme", "Dark");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Appearance" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await chooseTheme("Theme", "Light");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("follows the system again once System is chosen", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    restoreTheme();
    renderAppearanceSettings();
    expect(await screen.findByRole("combobox", { name: "Theme" })).toHaveValue(
      "dark",
    );

    await chooseTheme("Theme", "System");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("opens in the theme chosen on an earlier visit", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    restoreTheme();
    renderAppearanceSettings();
    expect(await screen.findByRole("combobox", { name: "Theme" })).toHaveValue(
      "light",
    );
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});

async function chooseTheme(label: string, name: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

function renderAppearanceSettings() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
        <RouterProvider
          router={createMemoryRouter(
            [
              {
                children: [
                  {
                    element: <AppearanceSettingsPage />,
                    path: "appearance",
                  },
                ],
                element: <SettingsLayout />,
                path: "/t/:tenantId/settings",
              },
            ],
            { initialEntries: ["/t/tenant-northstar/settings/appearance"] },
          )}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}
