import { Schema } from "effect"

/** Bounded operation name used by diagnostics whose producers are deliberately extensible. */
export const DiagnosticOperation = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.brand("DiagnosticOperation"),
)

/** Bounded operation name used by diagnostics whose producers are deliberately extensible. */
export type DiagnosticOperation = typeof DiagnosticOperation.Type
