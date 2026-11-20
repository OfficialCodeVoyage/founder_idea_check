import type { MetadataRoute } from "next";
import { config } from "@/lib/config";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: config.appName,
    // A home-screen label truncates after about 12 characters; the name fits whole.
    short_name: config.appName,
    description: config.appDescription,
    start_url: "/",
    display: "standalone",
    background_color: "#fff",
    theme_color: "#fff",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
