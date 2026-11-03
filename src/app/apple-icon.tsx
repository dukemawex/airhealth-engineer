import { ImageResponse } from "next/og";
import { logoDataUri } from "@/components/brand/logoGeometry";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
       
      <img src={logoDataUri({ squareTile: true })} width={180} height={180} alt="" />
    ),
    size,
  );
}
