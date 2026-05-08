import { useEffect } from "react";
import i18n from "./i18n";
import { useAppSelector } from "./store";

/**
 * Mirror the persisted Settings slice into the live DOM:
 *
 *  • `data-theme` attribute on `<html>` toggles dark/light token sets in
 *    `styles.css` (the light theme only overrides a handful of base
 *    tokens; everything else cascades).
 *
 *  • CSS custom properties (`--brand-color`, `--asset-moby`, …) override
 *    the static defaults declared in `:root`, so any rule written in
 *    terms of those vars updates immediately when the user picks a new
 *    color in the SettingsModal — no component re-render needed.
 *
 * Single subscription on the root component keeps the DOM in sync; no
 * other consumer needs to know about settings unless it specifically
 * reads colors for non-CSS use (e.g. Three.js materials, see
 * `useAssetColors`).
 */
export function useApplySettings(): void {
  const theme = useAppSelector((s) => s.settings.theme);
  const brand = useAppSelector((s) => s.settings.brandColor);
  const colors = useAppSelector((s) => s.settings.assetColors);
  const language = useAppSelector((s) => s.settings.language);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
    document.documentElement.setAttribute("lang", language);
  }, [language]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--brand-color", brand);
    root.style.setProperty("--accent-blue", brand);
    if (/^#[0-9a-fA-F]{6}$/.test(brand)) {
      root.style.setProperty("--tint-blue", `${brand}26`);
    }
  }, [brand]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--asset-moby", colors.moby);
    root.style.setProperty("--asset-tie", colors.tie);
    root.style.setProperty("--asset-ufrag", colors.ufrag);
    root.style.setProperty("--asset-selection", colors.selection);
    root.style.setProperty("--asset-proxy", colors.proxy);
  }, [colors.moby, colors.tie, colors.ufrag, colors.selection, colors.proxy]);
}

/**
 * Reactive accessor for the asset colors — used by Three.js code that
 * needs the literal hex string rather than a CSS variable. Returns the
 * whole `AssetColors` object; consumers that only care about one value
 * should `useAppSelector` directly to keep the subscription tight.
 */
export function useAssetColors() {
  return useAppSelector((s) => s.settings.assetColors);
}
