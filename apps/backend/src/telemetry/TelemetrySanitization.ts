import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

export type TelemetryErrorAttributes = {
  readonly errorCode?: string;
  readonly errorType: string;
};

const safeIdentifier = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : fallback;

export const telemetryErrorAttributes = (value: unknown): TelemetryErrorAttributes => {
  if (typeof value !== "object" || value === null) {
    return { errorType: "UnknownError" };
  }
  const tagged = value as {
    readonly _tag?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
  };
  const errorType = safeIdentifier(tagged._tag ?? tagged.name, "UnknownError");
  const code = safeIdentifier(tagged.code, "");
  return code === "" ? { errorType } : { errorCode: code, errorType };
};

const telemetrySafeError = (value: unknown): Error => {
  const attributes = telemetryErrorAttributes(value);
  const error = new Error(
    attributes.errorCode === undefined
      ? attributes.errorType
      : `${attributes.errorType}:${attributes.errorCode}`,
  );
  error.name = attributes.errorType;
  error.stack = attributes.errorType;
  return error;
};

export const sanitizeTelemetryExit = <A, E>(exit: Exit.Exit<A, E>): Exit.Exit<A, Error> => {
  if (Exit.isSuccess(exit)) return Exit.succeed(exit.value);
  return Exit.failCause(
    Cause.fromReasons(
      exit.cause.reasons.map((reason) => {
        if (Cause.isFailReason(reason)) {
          return Cause.makeFailReason(telemetrySafeError(reason.error));
        }
        if (Cause.isDieReason(reason)) {
          return Cause.makeDieReason(telemetrySafeError(reason.defect));
        }
        return reason;
      }),
    ),
  );
};

export const makeSanitizedTracer = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => end(endTime, sanitizeTelemetryExit(exit));
      return span;
    },
    ...(delegate.context === undefined ? {} : { context: delegate.context.bind(delegate) }),
  });
