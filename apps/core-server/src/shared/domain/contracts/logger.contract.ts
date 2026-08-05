/*
 * Structural subset of nestjs-pino's Logger (warn/error signatures match exactly), so
 * Service/UseCase depend on a domain-owned port instead of importing the Nest adapter directly.
 * Every real caller already passes a nestjs-pino Logger, which satisfies this shape as-is.
 */
export interface LoggerPort {
  warn(message: unknown, ...optionalParameters: unknown[]): void
  error(message: unknown, ...optionalParameters: unknown[]): void
}
