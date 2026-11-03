import type { NextConfig } from "next";

export const PERMISSIONS_POLICY = "camera=(self), microphone=(self), geolocation=(self), bluetooth=(self)";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Explicitly allow the features the app uses on its own origin:
          // live camera capture, Muse Voice / Web Speech mic, geolocation, Web Bluetooth.
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
        ],
      },
    ];
  },
};

export default nextConfig;
