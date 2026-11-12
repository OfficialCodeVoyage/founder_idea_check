import { ImageResponse } from "next/og";
import { BrandMark } from "@/components/brand-mark";

/**
 * The iOS home-screen icon (180×180), generated at build time from the same drawing as
 * `app/icon.svg`. Full-bleed square: iOS applies its own rounded mask.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<BrandMark size={180} square />, size);
}
