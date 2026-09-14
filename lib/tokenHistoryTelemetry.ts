import { z } from "zod";
import { TokenObservationSchema } from "./tokenHistory";

const TokenHistoryTelemetryEventBaseSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    observedAtMs: z.number().int().nonnegative(),
    topic: z.literal("token-history"),
    cluster: z.string().min(1),
    payload: TokenObservationSchema,
  })
  .strict();

function validateTokenHistoryEnvelope(
  event: { cluster: string; observedAtMs: number; payload: { cluster: string; atMs: number } },
  context: { addIssue: (issue: { code: "custom"; message: string; path: string[] }) => void },
): void {
  if (event.cluster !== event.payload.cluster) {
    context.addIssue({
      code: "custom",
      message: "Token history event cluster must match its payload cluster",
      path: ["payload", "cluster"],
    });
  }
  if (event.observedAtMs !== event.payload.atMs) {
    context.addIssue({
      code: "custom",
      message: "Token history event timestamp must match its payload timestamp",
      path: ["payload", "atMs"],
    });
  }
}

export const TokenHistoryTelemetryEventSchema = TokenHistoryTelemetryEventBaseSchema.superRefine(
  validateTokenHistoryEnvelope,
);
export type TokenHistoryTelemetryEvent = z.infer<typeof TokenHistoryTelemetryEventSchema>;

export const TokenHistoryTelemetryPublishEventSchema = TokenHistoryTelemetryEventBaseSchema.omit({
  version: true,
  revision: true,
}).superRefine(validateTokenHistoryEnvelope);

const TokenHistoryTelemetryResetEventBaseSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    observedAtMs: z.number().int().nonnegative(),
    topic: z.literal("token-history-reset"),
    cluster: z.string().min(1),
    payload: z.object({ reason: z.literal("topology-change") }).strict(),
  })
  .strict();

/**
 * A topology transition invalidates only in-memory live observations. Durable
 * history remains available from the token-history query.
 */
export const TokenHistoryTelemetryResetEventSchema = TokenHistoryTelemetryResetEventBaseSchema;
export type TokenHistoryTelemetryResetEvent = z.infer<typeof TokenHistoryTelemetryResetEventSchema>;

export const TokenHistoryTelemetryResetPublishEventSchema =
  TokenHistoryTelemetryResetEventBaseSchema.omit({
    version: true,
    revision: true,
  });

export const TokenHistoryTelemetryStreamEventSchema = z.discriminatedUnion("topic", [
  TokenHistoryTelemetryEventSchema,
  TokenHistoryTelemetryResetEventSchema,
]);
export type TokenHistoryTelemetryStreamEvent = z.infer<
  typeof TokenHistoryTelemetryStreamEventSchema
>;
