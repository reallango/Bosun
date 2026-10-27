import type { Config } from "tailwindcss";
import containerQueries from "@tailwindcss/container-queries";

/**
 * Theme colors live in CSS variables (hex). Tailwind 3 cannot apply opacity
 * modifiers (`bg-primary/10`) to plain `var()` colors, so expose them through
 * color-mix(), which works with any CSS color.
 */
function c(name: string) {
  return `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;
}

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Extra breakpoints for large / ultrawide monitors (sm..2xl are Tailwind defaults).
      screens: {
        xs: "480px",
        "3xl": "1920px",
        "4xl": "2400px",
      },
      // Container-query sizes used by widgets (@container + @xs:/@sm:/...).
      containers: {
        "3xs": "12rem",
        "2xs": "16rem",
      },
      colors: {
        background: c("background"),
        foreground: c("foreground"),
        card: { DEFAULT: c("card"), foreground: c("card-foreground") },
        popover: { DEFAULT: c("popover"), foreground: c("popover-foreground") },
        primary: { DEFAULT: c("primary"), foreground: c("primary-foreground") },
        secondary: { DEFAULT: c("secondary"), foreground: c("secondary-foreground") },
        muted: { DEFAULT: c("muted"), foreground: c("muted-foreground") },
        accent: { DEFAULT: c("accent"), foreground: c("accent-foreground") },
        destructive: { DEFAULT: c("destructive"), foreground: c("destructive-foreground") },
        border: c("border"),
        input: c("input"),
        ring: c("ring"),
        sidebar: {
          DEFAULT: c("sidebar"),
          foreground: c("sidebar-foreground"),
          muted: c("sidebar-muted"),
          accent: c("sidebar-accent"),
          border: c("sidebar-border"),
        },
        success: c("success"),
        warning: c("warning"),
      },
      ringWidth: {
        3: "3px",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      spacing: {
        "safe-t": "env(safe-area-inset-top)",
        "safe-b": "env(safe-area-inset-bottom)",
        "safe-l": "env(safe-area-inset-left)",
        "safe-r": "env(safe-area-inset-right)",
      },
    },
  },
  plugins: [containerQueries],
};
export default config;
