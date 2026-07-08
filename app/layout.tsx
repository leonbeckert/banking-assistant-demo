import type { Metadata } from "next";
import "./globals.css";

const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "Retail Bank";
const IS_BRANDED = BRAND_NAME !== "Retail Bank";

export const metadata: Metadata = {
  title: `${BRAND_NAME} Retail Assistant - Demo`,
  description: "Banking support chatbot demo. Answers from the FAQ and offers tailored help with your account.",
  // The branded mark lives in git-ignored /public/brand/ - the committed repo
  // only ships the neutral shield. Declare icon + shortcut + apple-touch-icon so
  // iOS Safari (which ignores a lone PNG rel=icon) actually shows the favicon.
  icons: IS_BRANDED
    ? { icon: "/brand/icon.png", shortcut: "/brand/icon.png", apple: "/brand/icon.png" }
    : { icon: "/neutral-icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased text-ink">
        {children}
        <footer className="mx-auto max-w-6xl px-6 pb-6 pt-2 text-center text-[11px] text-ink-faint">
          Technical demo built by Leon Beckert. Not a product of, and not affiliated with or
          endorsed by, {BRAND_NAME}{IS_BRANDED ? " or any bank" : ""}. All accounts, cards, and transactions are mock data.
        </footer>
      </body>
    </html>
  );
}
