import { randomUUID } from "node:crypto";

export const newId = (prefix: "ses" | "apr" | "int" | "act" | "req") =>
  `${prefix}_${randomUUID().replace(/-/g, "")}`;

export const nowIso = () => new Date().toISOString();
