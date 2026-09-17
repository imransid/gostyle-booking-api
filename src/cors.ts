/**
 * Who may call this API from a browser.
 *
 * NOTHING ENABLED CORS BEFORE THIS. curl worked, Swagger worked -- /docs is
 * served by this app, so it is same-origin -- and every fetch from a front end
 * on another origin was blocked by the browser before the server saw it. The
 * server logs stay empty in that case, which is what makes it look like the
 * front end's bug.
 *
 * AN ALLOWLIST FROM ENV, NOT '*'. Origins differ per environment and a source
 * change per deployment is how one gets forgotten. `*` is still reachable by
 * setting CORS_ORIGINS=*, which is defensible here only because this API
 * authenticates with a bearer token and never a cookie: credentials stay off
 * below, so a wildcard cannot be used to ride someone's session.
 *
 * Unset means local development, and the defaults below are the ports the
 * usual dev servers pick. A deployment that sets nothing therefore accepts no
 * production front end at all -- deliberately: failing closed is a support
 * ticket, failing open is an incident.
 */

export interface CorsConfig {
  readonly origin: string[] | boolean;
  readonly methods: string[];
  readonly allowedHeaders: string[];
  readonly exposedHeaders: string[];
  readonly credentials: boolean;
  readonly maxAge: number;
}

/** Vite, CRA, Next, Angular, and the same four on 127.0.0.1. */
export const DEV_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:4200',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

export function corsOptions(raw = process.env.CORS_ORIGINS): CorsConfig {
  const listed = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return {
    origin: listed.includes('*')
      ? true
      : listed.length > 0
        ? listed
        : [...DEV_ORIGINS],

    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],

    /**
     * Idempotency-Key IS NOT OPTIONAL IN THIS LIST. POST /v1/bookings sends
     * it, and a header the preflight does not allow fails the whole request
     * in the browser -- before it is sent, with a CORS message that names the
     * header only if you open the console. Confirm would be the one call in
     * the flow that mysteriously never happens.
     */
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      /**
       * X-Tenant-Id AND X-Branch-Id FOR THE SAME REASON AS Idempotency-Key.
       *
       * TenantMiddleware has read X-Tenant-Id since tenancy landed, and this
       * list did not allow it -- so a browser could never send one. The
       * preflight rejected it before the request left, every row a browser
       * wrote was untenanted, and nothing anywhere said so. curl and Swagger
       * were unaffected, which is why it survived.
       */
      'X-Tenant-Id',
      'X-Branch-Id',
    ],

    /** So a client can read its own rate-limit and correlation headers later. */
    exposedHeaders: ['Content-Length', 'ETag'],

    // Bearer tokens, never cookies. Nothing to send credentials for, and
    // leaving this false is what keeps CORS_ORIGINS=* merely untidy rather
    // than dangerous.
    credentials: false,

    // Cache the preflight for a day: the flow makes several POSTs in a row
    // and each one would otherwise pay for its own OPTIONS round trip.
    maxAge: 86_400,
  };
}
