import type { Metadata } from "next";

import { Faq } from "@/components/faq";
import { Features } from "@/components/features";
import { Footer } from "@/components/footer";
import { GetStarted } from "@/components/get-started";
import { Hero } from "@/components/hero";
import { LogoCloud } from "@/components/logo-cloud";
import { Navbar } from "@/components/navbar";
import { Platforms } from "@/components/platforms";
import { TechStack } from "@/components/tech-stack";
import { UseCases } from "@/components/use-cases";
import { siteConfig, siteLinks } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "The Prod-Ready AI Chat App",
  description:
    "Stop rebuilding the same AI chat infrastructure. ChatJS gives you a production-ready foundation with auth, streaming, tool calling, and 120+ models.",
  alternates: {
    canonical: siteLinks.home,
  },
  openGraph: {
    url: siteLinks.home,
    title: "ChatJS - Stop Rebuilding the Same AI Chat Infrastructure",
    description:
      "A production-ready foundation with auth, streaming, tool calling, and 120+ models. Scaffold it, customize it, ship it.",
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: siteConfig.name,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web, macOS, Windows, Linux",
      url: siteLinks.home,
      description: siteConfig.description,
      image: `${siteConfig.url}${siteConfig.ogImage}`,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      softwareHelp: siteLinks.docs,
      codeRepository: siteLinks.github,
      screenshot: `${siteConfig.url}${siteConfig.ogImage}`,
    },
    {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteLinks.home,
      logo: `${siteConfig.url}/logo.svg`,
      sameAs: [siteLinks.github],
    },
    {
      "@type": "WebSite",
      name: siteConfig.name,
      url: siteLinks.home,
      description: siteConfig.description,
    },
  ],
};

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <script type="application/ld+json">
        {JSON.stringify(structuredData)}
      </script>
      <Navbar />
      <main className="flex-1">
        <Hero />
        <LogoCloud />
        <Features />
        <TechStack />
        <Platforms />
        <UseCases />
        <Faq />
        <GetStarted />
      </main>
      <Footer />
    </div>
  );
}
