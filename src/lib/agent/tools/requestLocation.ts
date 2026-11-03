import { z } from "zod";
import { formatPlace } from "../../place";
import { defineTool } from "./types";

export const requestLocationSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(160)
    .default("to check the air where you are")
    .describe("Short reason shown on the card, e.g. 'to find your best time to exercise outside'"),
});

/**
 * UI action: shows the user an inline "Share my location" card (device geolocation
 * button + city box). When they share, the client posts the coordinates with a
 * follow-up message, which resumes the turn. The server never sees a location here.
 */
export const requestLocationTool = defineTool({
  name: "requestLocation",
  description:
    "Ask the user for their location with an inline card (one-tap device location, or type a city). Call this whenever a request needs a place and none is on file (getAirQuality/planForecast return needsLocation), or when the user asks you to use their device location. After calling it, end your reply with ONE short line (e.g. 'Tap Share my location above, or type a city.'). Never ask for coordinates in text.",
  schema: requestLocationSchema,
  requiresApproval: false,
  async execute(args, ctx) {
    const loc = ctx.session.location;
    if (loc) {
      return { alreadyKnown: true, place: formatPlace(loc), note: "A location is already on file; use it (call getAirQuality with no arguments)." };
    }
    return {
      needsLocation: true,
      reason: args.reason,
      shown: "Share-my-location card is now visible to the user. End your reply with one short line and wait.",
    };
  },
});
