import { useDirection } from "@base-ui/react/direction-provider";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";
import { LanguageStep } from "../components/onboarding/SetupPrivacySteps";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Sidebar, SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { render } from "../../test/render";
import { I18nProvider } from "./I18nProvider";
import { startI18n } from "./runtime";
import { getClientSettings, updateClientSettings, useClientSettings } from "../hooks/useSettings";

function DirectionProbe() {
  const direction = useDirection();
  return <span data-testid="base-ui-direction">{direction}</span>;
}

function LanguageStepHarness() {
  const language = useClientSettings((settings) => settings.language);
  const locale = language === "ar" ? "ar" : "en";
  return (
    <LanguageStep
      locale={locale}
      onLocale={(next) => {
        void updateClientSettings({ language: next });
      }}
    />
  );
}

describe("RTL layout and i18n direction", () => {
  it("syncs document lang/dir and Base UI DirectionProvider across ar and en", async () => {
    const previousDir = document.documentElement.dir;
    const previousLang = document.documentElement.lang;
    try {
      startI18n();
      updateClientSettings({ language: "ar" });
      await using screen = await render(
        <I18nProvider>
          <DirectionProbe />
        </I18nProvider>,
        {
          // Direction plumbing does not depend on router state.
          router: false,
        },
      );
      await expect.element(screen.getByTestId("base-ui-direction")).toHaveTextContent("rtl");
      expect(document.documentElement.dir).toBe("rtl");
      expect(document.documentElement.lang).toBe("ar");

      updateClientSettings({ language: "en" });
      await expect.element(screen.getByTestId("base-ui-direction")).toHaveTextContent("ltr");
      expect(document.documentElement.dir).toBe("ltr");
      expect(document.documentElement.lang).toBe("en");
    } finally {
      updateClientSettings({ language: "en" });
      document.documentElement.dir = previousDir;
      document.documentElement.lang = previousLang;
    }
  });

  it("places the sidebar on the right edge in RTL and the left edge in LTR", async () => {
    const previousDir = document.documentElement.dir;
    try {
      await page.viewport(1280, 800);
      document.documentElement.dir = "rtl";
      await using rtlScreen = await render(
        <div className="w-[1000px]">
          <SidebarProvider defaultOpen>
            <Sidebar side="left">
              <div data-testid="sidebar-body">Nav</div>
            </Sidebar>
            <SidebarInset>
              <main data-testid="main-body">Main</main>
            </SidebarInset>
          </SidebarProvider>
        </div>,
        {
          // Pure layout check without navigation.
          router: false,
        },
      );
      const rtlSidebar = rtlScreen.container.querySelector('[data-slot="sidebar-container"]');
      const rtlMain = rtlScreen.container.querySelector('[data-testid="main-body"]');
      expect(rtlSidebar).not.toBeNull();
      expect(rtlMain).not.toBeNull();
      const rtlSidebarRect = rtlSidebar!.getBoundingClientRect();
      const rtlMainRect = rtlMain!.getBoundingClientRect();
      expect(rtlSidebarRect.left).toBeGreaterThan(rtlMainRect.left);

      document.documentElement.dir = "ltr";
      await using ltrScreen = await render(
        <div className="w-[1000px]">
          <SidebarProvider defaultOpen>
            <Sidebar side="left">
              <div data-testid="sidebar-body">Nav</div>
            </Sidebar>
            <SidebarInset>
              <main data-testid="main-body">Main</main>
            </SidebarInset>
          </SidebarProvider>
        </div>,
        {
          // Pure layout check without navigation.
          router: false,
        },
      );
      const ltrSidebar = ltrScreen.container.querySelector('[data-slot="sidebar-container"]');
      const ltrMain = ltrScreen.container.querySelector('[data-testid="main-body"]');
      const ltrSidebarRect = ltrSidebar!.getBoundingClientRect();
      const ltrMainRect = ltrMain!.getBoundingClientRect();
      expect(ltrSidebarRect.left).toBeLessThan(ltrMainRect.left);
    } finally {
      document.documentElement.dir = previousDir;
    }
  });

  it("positions the dialog close button at inline-end (left) in RTL", async () => {
    const previousDir = document.documentElement.dir;
    try {
      await page.viewport(1280, 800);
      document.documentElement.dir = "rtl";
      await using _screen = await render(
        <Dialog open>
          <DialogPopup>
            <DialogTitle>RTL Dialog</DialogTitle>
          </DialogPopup>
        </Dialog>,
        {
          // Pure layout check without navigation.
          router: false,
        },
      );
      const popup = page.getByRole("dialog");
      await expect.element(popup).toBeVisible();
      const closeButton = page.getByRole("button", { name: "Close" });
      await expect.element(closeButton).toBeVisible();
      const popupRect = popup.element().getBoundingClientRect();
      const closeRect = closeButton.element().getBoundingClientRect();
      // In RTL, inline-end is near the physical left edge of the dialog.
      expect(closeRect.left - popupRect.left).toBeLessThan(popupRect.right - closeRect.right);
    } finally {
      document.documentElement.dir = previousDir;
    }
  });

  it("switches app language, RTL direction, and Arabic catalog copy from setup LanguageStep", async () => {
    const previousDir = document.documentElement.dir;
    const previousLang = document.documentElement.lang;
    try {
      startI18n();
      updateClientSettings({ language: "en" });
      await using screen = await render(
        <I18nProvider>
          <LanguageStepHarness />
        </I18nProvider>,
        {
          // Pure i18n/direction check without navigation.
          router: false,
        },
      );
      await expect.element(screen.getByText(/Choose your language for DoeDesk/)).toBeVisible();
      expect(document.documentElement.dir).toBe("ltr");

      await userEvent.click(screen.getByRole("radio", { name: "العربية" }));
      await expect.element(screen.getByText(/اختر لغة DoeDesk/)).toBeVisible();
      expect(document.documentElement.dir).toBe("rtl");
      expect(document.documentElement.lang).toBe("ar");
      expect(getClientSettings().language).toBe("ar");

      await userEvent.click(screen.getByRole("radio", { name: "English" }));
      await expect.element(screen.getByText(/Choose your language for DoeDesk/)).toBeVisible();
      expect(document.documentElement.dir).toBe("ltr");
      expect(document.documentElement.lang).toBe("en");
      expect(getClientSettings().language).toBe("en");
    } finally {
      updateClientSettings({ language: "en" });
      document.documentElement.dir = previousDir;
      document.documentElement.lang = previousLang;
    }
  });
});
