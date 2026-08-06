import type { MetadataRoute } from "next";

import { siteConfig, siteLinks } from "@/lib/site-config";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${siteConfig.name} - Open-Source AI Chat Starter`,
    short_name: siteConfig.shortName,
    description: siteConfig.description,
    start_url: "/",
    display: "standalone",
    background_color: "#f8f7f4",
    theme_color: "#09090b",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
    ],
    categories: ["developer tools", "productivity", "artificial intelligence"],
    shortcuts: [
      {
        name: "Documentation",
        url: siteLinks.docs,
      },
      {
        name: "Demo",
        url: siteLinks.demo,
      },
    ],
  };
}
