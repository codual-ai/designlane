/** Material's type scales, and how Compose writes a font's weight and size. */

import { COMPUTED } from "../scan/type-scale.js";

/** The platform font, Roboto on Android, as the shared type scale names it. */
export const SYSTEM = "System";

type Default = { size: number; weight: string };

/** Each role's default in Material 3 and Material 2, whose role names don't overlap. */
export const MATERIAL_DEFAULTS: Record<string, Default> = {
  displayLarge: { size: 57, weight: "regular" },
  displayMedium: { size: 45, weight: "regular" },
  displaySmall: { size: 36, weight: "regular" },
  headlineLarge: { size: 32, weight: "regular" },
  headlineMedium: { size: 28, weight: "regular" },
  headlineSmall: { size: 24, weight: "regular" },
  titleLarge: { size: 22, weight: "regular" },
  titleMedium: { size: 16, weight: "medium" },
  titleSmall: { size: 14, weight: "medium" },
  bodyLarge: { size: 16, weight: "regular" },
  bodyMedium: { size: 14, weight: "regular" },
  bodySmall: { size: 12, weight: "regular" },
  labelLarge: { size: 14, weight: "medium" },
  labelMedium: { size: 12, weight: "medium" },
  labelSmall: { size: 11, weight: "medium" },
  h1: { size: 96, weight: "light" },
  h2: { size: 60, weight: "light" },
  h3: { size: 48, weight: "regular" },
  h4: { size: 34, weight: "regular" },
  h5: { size: 24, weight: "regular" },
  h6: { size: 20, weight: "medium" },
  subtitle1: { size: 16, weight: "regular" },
  subtitle2: { size: 14, weight: "medium" },
  body1: { size: 16, weight: "regular" },
  body2: { size: 14, weight: "regular" },
  button: { size: 14, weight: "medium" },
  caption: { size: 12, weight: "regular" },
  overline: { size: 10, weight: "regular" },
};

const UNDERSCORES = /_/g;
/** Weights by the hundred, 100 to 900. */
const BY_HUNDRED = ["thin", "ultraLight", "light", "regular", "medium", "semibold", "bold", "heavy", "black"];
/** Compose's named weights (`FontWeight.SemiBold`), each as the name Designmap gives it. */
export const COMPOSE_WEIGHTS: Record<string, string> = {
  Thin: "thin",
  ExtraLight: "ultraLight",
  Light: "light",
  Normal: "regular",
  Medium: "medium",
  SemiBold: "semibold",
  Bold: "bold",
  ExtraBold: "heavy",
  Black: "black",
};

/** `FontWeight.SemiBold`, `FontWeight.W600` or `FontWeight(600)` as `semibold`; anything else is worked out as the
 * app runs. */
export function weightOf(expression: string): string {
  const named = expression.match(/^FontWeight\.(\w+)$/)?.[1] ?? "";
  if (COMPOSE_WEIGHTS[named]) return COMPOSE_WEIGHTS[named];
  const number = Number(
    named.match(/^W(\d00)$/)?.[1] ??
      expression.match(/^FontWeight\s*\(\s*(?:weight\s*=\s*)?(\d+)\s*\)$/)?.[1],
  );
  return weightByHundred(number);
}

/** `600` as `semibold`; anything but 100 to 900 is worked out as the app runs. */
export function weightByHundred(number: number): string {
  return (Number.isFinite(number) && BY_HUNDRED[Math.round(number / 100) - 1]) || COMPUTED;
}

/** `16.sp` or `1_000.sp` as a number, or undefined when it's worked out as the app runs. */
export function sizeOf(expression: string): number | undefined {
  const m = expression.match(/^(\d[\d_]*(?:\.\d+)?)\.sp$/);
  return m?.[1] ? Number(m[1].replace(UNDERSCORES, "")) : undefined;
}
