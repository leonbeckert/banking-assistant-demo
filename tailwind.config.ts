import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Neutral banking palette - quiet, trustworthy, screen-share legible.
        ink: {
          DEFAULT: "#0f172a", // slate-900
          soft: "#334155", // slate-700
          faint: "#64748b", // slate-500
        },
        canvas: "#f8fafc", // slate-50 - page background
        card: "#ffffff",
        line: "#e2e8f0", // slate-200 - borders
        // A single restrained accent (deep teal-blue), used sparingly.
        accent: {
          DEFAULT: "#0e7490", // cyan-700
          soft: "#ecfeff", // cyan-50
          ring: "#a5f3fc", // cyan-200
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)",
        lift: "0 10px 30px -12px rgb(15 23 42 / 0.25)",
        phone: "0 30px 60px -15px rgb(15 23 42 / 0.45)",
      },
    },
  },
  plugins: [],
};

export default config;
