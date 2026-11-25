import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { Router, type Request, type RequestHandler } from "express";
import { config } from "./config.js";
import { getRedis } from "./redis.js";

type JsonRecord = Record<string, unknown>;

export type WorkspaceMembership = { id: string; role: "admin" | "agent" };
export type Session = { sub: string; workspaces: WorkspaceMembership[] };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function randomToken(): string {
  return base64Url(randomBytes(32));
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export async function getSession(req: Request): Promise<Session | null> {
  const id = cookieValue(req, "switchboard_session");
  if (!id) return null;
  const stored = await getRedis().get(`switchboard:session:${id}`);
  if (!stored) return null;

  const parsed: unknown = JSON.parse(stored);
  if (
    !isRecord(parsed) ||
    typeof parsed.sub !== "string" ||
    !Array.isArray(parsed.workspaces)
  ) {
    return null;
  }

  const workspaces = parsed.workspaces.filter(
    (item): item is WorkspaceMembership =>
      isRecord(item) &&
      typeof item.id === "string" &&
      (item.role === "admin" || item.role === "agent"),
  );
  return { sub: parsed.sub, workspaces };
}

export function hasWorkspace(session: Session, workspace: string): boolean {
  return session.workspaces.some((membership) => membership.id === workspace);
}

async function discover(): Promise<JsonRecord> {
  const response = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery returned ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("OIDC discovery response is invalid");
  return value;
}

async function verifyIdToken(token: string, nonce: string): Promise<Session> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OIDC id_token is malformed");

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("OIDC id_token is malformed");
  }
  if (!isRecord(header) || !isRecord(claims) || header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("OIDC id_token header or claims are invalid");
  }

  const metadata = await discover();
  if (typeof metadata.jwks_uri !== "string") throw new Error("OIDC JWKS endpoint is missing");
  const jwksResponse = await fetch(metadata.jwks_uri);
  if (!jwksResponse.ok) throw new Error(`OIDC JWKS returned ${jwksResponse.status}`);
  const jwks: unknown = await jwksResponse.json();
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) throw new Error("OIDC JWKS response is invalid");
  const jwk = jwks.keys.find((key) => isRecord(key) && key.kid === header.kid);
  if (!isRecord(jwk)) throw new Error("OIDC signing key was not found");

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signature = Buffer.from(parts[2], "base64url");
  const validSignature = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    signature,
  );
  const audience = claims.aud;
  const validAudience =
    audience === config.oidc.clientId ||
    (Array.isArray(audience) && audience.includes(config.oidc.clientId));
  const now = Math.floor(Date.now() / 1000);
  if (
    !validSignature ||
    claims.iss !== config.oidc.issuer ||
    !validAudience ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    typeof claims.iat !== "number" ||
    claims.iat > now + 60 ||
    claims.nonce !== nonce ||
    typeof claims.sub !== "string" ||
    !Array.isArray(claims.workspaces)
  ) {
    throw new Error("OIDC id_token validation failed");
  }

  const workspaces = claims.workspaces.filter(
    (item): item is WorkspaceMembership =>
      isRecord(item) &&
      typeof item.id === "string" &&
      (item.role === "admin" || item.role === "agent"),
  );
  return { sub: claims.sub, workspaces };
}

export const authRouter = Router();

authRouter.get("/login", async (_req, res, next) => {
  try {
    const metadata = await discover();
    if (typeof metadata.authorization_endpoint !== "string") {
      throw new Error("OIDC authorization endpoint is missing");
    }

    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await getRedis().set(
      `switchboard:oidc:${state}`,
      JSON.stringify({ nonce, verifier }),
      "EX",
      600,
    );

    const authorize = new URL(metadata.authorization_endpoint);
    authorize.searchParams.set("client_id", config.oidc.clientId);
    authorize.searchParams.set("redirect_uri", config.oidc.redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid profile email");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    res.redirect(authorize.toString());
  } catch (error) {
    next(error);
  }
});

authRouter.get("/callback", async (req, res, next) => {
  const code = req.query.code;
  const state = req.query.state;
  if (typeof code !== "string" || typeof state !== "string") {
    res.status(400).send("Missing authorization code or state");
    return;
  }

  try {
    const redis = getRedis();
    const stored = await redis.getdel(`switchboard:oidc:${state}`);
    if (!stored) {
      res.status(400).send("Invalid or expired login state");
      return;
    }
    const flow: unknown = JSON.parse(stored);
    if (
      !isRecord(flow) ||
      typeof flow.nonce !== "string" ||
      typeof flow.verifier !== "string"
    ) {
      res.status(400).send("Invalid login state");
      return;
    }

    const metadata = await discover();
    if (typeof metadata.token_endpoint !== "string") {
      throw new Error("OIDC token endpoint is missing");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: flow.verifier,
    });
    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!tokenResponse.ok) {
      res.status(401).send("Identity provider rejected the login");
      return;
    }
    const tokens: unknown = await tokenResponse.json();
    if (!isRecord(tokens) || typeof tokens.id_token !== "string") {
      throw new Error("OIDC token response is invalid");
    }

    const session = await verifyIdToken(tokens.id_token, flow.nonce);
    const sessionId = randomToken();
    await redis.set(
      `switchboard:session:${sessionId}`,
      JSON.stringify(session),
      "EX",
      8 * 60 * 60,
    );
    res.setHeader(
      "set-cookie",
      `switchboard_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8 * 60 * 60}`,
    );
    res.redirect(config.webOrigin);
  } catch (error) {
    next(error);
  }
});
