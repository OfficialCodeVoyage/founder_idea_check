import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    optimizePackageImports: [
      "react-tweet",
      "echarts-for-react",
      "lucide-react",
    ],
    staleTimes: {
      dynamic: 0,
      static: 30,
    },
  },
  serverExternalPackages: ["pino", "pino-pretty"],
  /**
   * lib/phases/runtime.ts reads the phase prompts off disk at request time
   * (`readFileSync(join(process.cwd(), "prompts", ...))`). Next's tracer only
   * bundles files it can see statically, and a runtime-built path is invisible
   * to it — so on Vercel or in a standalone build the whole prompts/ directory
   * is absent.
   *
   * loadPrompt DEGRADES rather than throwing, which is right for a missing
   * file but disastrous here: it returns "", the empty section is dropped, and
   * the app serves a persona-less, brief-less assistant that looks like it is
   * working. The gate then judges a transcript produced without the rubric it
   * is judging against. There is no error, no 500, and nothing in the UI.
   *
   * Traced explicitly so the failure cannot happen. Verify after any change to
   * how prompts are loaded.
   */
  outputFileTracingIncludes: {
    "/**": ["./prompts/**/*"],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.googleusercontent.com",
        pathname: "**",
      },
      {
        hostname: "avatars.githubusercontent.com",
      },
      {
        hostname: "*.public.blob.vercel-storage.com",
      },
      { hostname: "www.google.com" },
      {
        hostname: "models.dev",
      },
    ],
  },
};

export default nextConfig;
