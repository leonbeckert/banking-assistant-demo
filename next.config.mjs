/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle for the container image. No effect on
  // `next dev` (the local demo) — only changes `next build` output.
  output: "standalone",
};

export default nextConfig;
