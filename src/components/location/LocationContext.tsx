"use client";

import { createContext, useContext } from "react";
import type { LocationQuery } from "@/lib/domain";
import type { GeoFailureKind } from "@/lib/client/geolocation";

export interface LocationActions {
  /** Post a location to the session with a short follow-up message; resumes the agent turn. */
  share: (location: LocationQuery, label: string) => void;
  /** Place on file for this session, if any. */
  known: string | null;
  busy: boolean;
  /** The last device-location failure (e.g. denied on a quick start), shown on the card. */
  lastFailure: GeoFailureKind | null;
}

export const LocationActionsContext = createContext<LocationActions | null>(null);
export const useLocationActions = () => useContext(LocationActionsContext);
