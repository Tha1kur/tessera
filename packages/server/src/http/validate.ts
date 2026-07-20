import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";

/**
 * Request validation.
 *
 * Every handler downstream of this can treat its input as correct, because
 * anything that is not correct never reaches it. The original project read
 * `req.body` fields directly and passed them to the database, which is how a
 * missing field became a 500 and an unexpected one became whatever the database
 * decided to do with it.
 *
 * The parsed result *replaces* the raw input. That matters: Zod strips unknown
 * keys by default, so a request smuggling `{ role: "admin" }` into a profile
 * update has that key removed rather than forwarded to an unwitting `update`.
 */

export interface RequestSchemas {
  readonly body?: ZodTypeAny;
  readonly params?: ZodTypeAny;
  readonly query?: ZodTypeAny;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    try {
      if (schemas.params) request.params = schemas.params.parse(request.params);
      if (schemas.query) {
        // Express 5 makes req.query a getter, so assigning to it throws.
        // Defining the property keeps this working on both major versions.
        Object.defineProperty(request, "query", {
          value: schemas.query.parse(request.query),
          writable: true,
          configurable: true,
        });
      }
      if (schemas.body) request.body = schemas.body.parse(request.body);

      next();
    } catch (error) {
      // ZodError is translated to a 400 with per-field detail by errorHandler.
      next(error);
    }
  };
}

/**
 * Read route params or query with the shape their schema guarantees.
 *
 * Express types `req.params` as `Record<string, string | undefined>`, which is
 * honest for an unvalidated request but wrong once `validate` has run: the
 * schema already rejected anything missing or malformed, and it coerced
 * `"42"` into a number. This helper carries that guarantee into the type
 * system in one place, instead of a cast at every call site where the reason
 * for it would go unexplained.
 *
 * Passing the schema is what keeps it honest - the type comes from the same
 * schema the middleware enforced, so the two cannot drift apart.
 */
export function parsed<S extends ZodTypeAny>(value: unknown, _schema: S): z.infer<S> {
  return value as z.infer<S>;
}

/** The type a handler receives once a body schema has run. */
export type Validated<S extends ZodTypeAny> = Request & { body: z.infer<S> };

/** Both body and params typed together, for handlers that need each. */
export type ValidatedRequest<B extends ZodTypeAny, P extends ZodTypeAny> = Request & {
  body: z.infer<B>;
  params: z.infer<P>;
};
