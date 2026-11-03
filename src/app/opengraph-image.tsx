import { ImageResponse } from "next/og";
import { logoDataUri } from "@/components/brand/logoGeometry";

export const alt = "AirHealth Engineer: live air quality turned into human-approved protection";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #062f38 0%, #0b6477 60%, #14b8a6 100%)",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "32px" }}>
          { }
          <img src={logoDataUri()} width={140} height={140} alt="" />
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: "-0.02em" }}>AirHealth Engineer</div>
        </div>
        <div style={{ marginTop: 40, fontSize: 36, color: "#ccfbf1", maxWidth: 940, lineHeight: 1.3 }}>
          An autonomous Muse Spark agent that turns live air quality and your health context into engineered,
          human-approved protection.
        </div>
      </div>
    ),
    size,
  );
}
