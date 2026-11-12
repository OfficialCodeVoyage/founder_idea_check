import { ImageResponse } from "next/og";
import { BRAND_BLUE, BrandMark } from "@/components/brand-mark";

/**
 * The link-preview image (1200×630), generated at build time instead of shipping a binary.
 * It shows the product's one idea: a row of eight gates, the first three passed, the fourth the
 * one the founder is working on. Colours are the app's light-theme tokens (`app/globals.css`):
 * background `--background`, text `--foreground`, secondary text `--muted-foreground`.
 * The font is the Geist Regular that `next/og` bundles, so the build needs no network.
 */
export const alt =
  "Founder Idea Check: test an idea before you build it. Eight phases, and no gate opens without real evidence.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FOREGROUND = "#333333";
const MUTED = "#6b7280";
const PENDING = "#d1d5db";

const PHASES = 8;
const PASSED = 3;

function OpenGate({ color, size: px }: { color: string; size: number }) {
  return (
    <svg
      aria-label="Phase gate"
      height={px}
      role="img"
      viewBox="0 0 64 64"
      width={px}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        fill="none"
        height="61"
        rx="14"
        stroke={color}
        strokeWidth="3"
        width="61"
        x="1.5"
        y="1.5"
      />
      <path
        d="M16 51V30a16 16 0 0 1 32 0v21"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth="6"
      />
    </svg>
  );
}

export default function OpengraphImage() {
  const gates = Array.from({ length: PHASES }, (_, index) => index);
  return new ImageResponse(
    <div
      style={{
        background: "#ffffff",
        color: FOREGROUND,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: "72px 80px",
        width: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 22 }}>
        <BrandMark size={64} />
        <div style={{ fontSize: 40 }}>Founder Idea Check</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
          {gates.map((index) => {
            if (index < PASSED) {
              return <BrandMark key={index} size={60} />;
            }
            return (
              <OpenGate
                color={index === PASSED ? BRAND_BLUE : PENDING}
                key={index}
                size={60}
              />
            );
          })}
        </div>
        <div style={{ fontSize: 68, marginTop: 40 }}>
          Test an idea before you build it.
        </div>
        <div style={{ color: MUTED, fontSize: 32, marginTop: 16 }}>
          Eight phases, and no gate opens without real evidence.
        </div>
      </div>

      <div
        style={{
          color: MUTED,
          display: "flex",
          fontSize: 24,
          justifyContent: "space-between",
        }}
      >
        <div>Open source under Apache-2.0</div>
        <div>github.com/OfficialCodeVoyage/founder_idea_check</div>
      </div>
    </div>,
    size
  );
}
