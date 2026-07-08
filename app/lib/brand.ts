// Brand name is injected at build time via NEXT_PUBLIC_BRAND_NAME.
// Default stays neutral ("Retail Bank") so the public repo carries no real-bank
// branding - set NEXT_PUBLIC_BRAND_NAME in a git-ignored .env.local for live demos.
export const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "Retail Bank";

// True only when a real client brand is set (live demo / screenshots). Gates
// client-specific copy - e.g. naming the customer's internal LLM platform in the
// footer - so the committed neutral default stays free of any real-bank facts.
export const IS_BRANDED = BRAND_NAME !== "Retail Bank";
