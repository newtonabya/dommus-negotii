import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Presigned URLs live 5 minutes (PRD F3). */
export const URL_TTL_SECONDS = 5 * 60;

const KEY_PATTERN = /^(staging|files)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export function stagingKey(uploadId: string): string {
  return `staging/${uploadId}`;
}

/** Final location: content-addressed, so a file is stored once and never overwritten. */
export function fileKey(sha256: string): string {
  return `files/${sha256.slice(0, 2)}/${sha256}`;
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid evidence key: ${key}`);
}

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
}

/**
 * Where evidence bytes live. Files under files/ are never deleted or
 * overwritten (production: R2 bucket lock); only staging/ objects are removed.
 */
export interface EvidenceStore {
  readonly name: string;
  presignPut(key: string, contentType: string): Promise<PresignedPut>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  putFile(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deleteStaging(key: string): Promise<void>;
  presignGet(key: string, filename: string, contentType: string): Promise<string>;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ───────────────────────────── S3-compatible (R2, Neon) ─────────────────────────────

export interface S3StoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3EvidenceStore implements EvidenceStore {
  readonly name = "s3";
  private readonly client: S3Client;

  constructor(private readonly config: S3StoreConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async presignPut(key: string, contentType: string): Promise<PresignedPut> {
    assertKey(key);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: contentType }),
      { expiresIn: URL_TTL_SECONDS },
    );
    return { url, headers: { "Content-Type": contentType } };
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return out.Body ? await out.Body.transformToByteArray() : null;
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return true;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw error;
    }
  }

  async putFile(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: contentType }),
    );
  }

  async deleteStaging(key: string): Promise<void> {
    if (!key.startsWith("staging/")) throw new Error("Only staging objects may be deleted");
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async presignGet(key: string, filename: string, contentType: string): Promise<string> {
    assertKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: contentDisposition(filename),
      }),
      { expiresIn: URL_TTL_SECONDS },
    );
  }
}

// ───────────────────────────── Local folder (development, tests) ─────────────────────────────

export const LOCAL_STORE_ROUTE = "/api/dev/evidence-store";

export interface LocalSignedRequest {
  op: "put" | "get";
  key: string;
  exp: number;
  ct: string;
  fn: string;
}

/** Stores evidence in a local folder and signs URLs served by the dev-only route. */
export class LocalEvidenceStore implements EvidenceStore {
  readonly name = "local";

  constructor(
    private readonly rootDir: string,
    private readonly secret: string,
  ) {}

  private pathFor(key: string): string {
    assertKey(key);
    return path.join(this.rootDir, ...key.split("/"));
  }

  sign(req: Omit<LocalSignedRequest, "exp">, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + URL_TTL_SECONDS;
    const sig = this.signature({ ...req, exp });
    const params = new URLSearchParams({ op: req.op, key: req.key, exp: String(exp), ct: req.ct, fn: req.fn, sig });
    return `${LOCAL_STORE_ROUTE}?${params.toString()}`;
  }

  private signature(req: LocalSignedRequest): string {
    return createHmac("sha256", this.secret)
      .update([req.op, req.key, req.exp, req.ct, req.fn].join("\n"))
      .digest("base64url");
  }

  /** Checks a signed request; returns it when valid and unexpired. */
  verify(params: URLSearchParams, now = Date.now()): LocalSignedRequest | null {
    const op = params.get("op");
    const key = params.get("key") ?? "";
    const exp = Number(params.get("exp"));
    const ct = params.get("ct") ?? "";
    const fn = params.get("fn") ?? "";
    const sig = params.get("sig") ?? "";
    if ((op !== "put" && op !== "get") || !KEY_PATTERN.test(key) || !Number.isInteger(exp)) return null;
    if (exp * 1000 < now) return null;
    const expected = Buffer.from(this.signature({ op, key, exp, ct, fn }));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { op, key, exp, ct, fn };
  }

  async presignPut(key: string, contentType: string): Promise<PresignedPut> {
    assertKey(key);
    return { url: this.sign({ op: "put", key, ct: contentType, fn: "" }), headers: { "Content-Type": contentType } };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async putFile(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: key.startsWith("files/") ? "wx" : "w" }).catch((error: unknown) => {
      // files/ is write-once, like the production bucket lock.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }

  async deleteStaging(key: string): Promise<void> {
    if (!key.startsWith("staging/")) throw new Error("Only staging objects may be deleted");
    await rm(this.pathFor(key), { force: true });
  }

  async presignGet(key: string, filename: string, contentType: string): Promise<string> {
    assertKey(key);
    return this.sign({ op: "get", key, ct: contentType, fn: filename });
  }
}

// ───────────────────────────── Selection ─────────────────────────────

let cached: EvidenceStore | null = null;

/**
 * EVIDENCE_STORE=s3 uses the EVIDENCE_S3_* settings (Cloudflare R2 in
 * production); local (the development default) uses a git-ignored folder.
 */
export function getEvidenceStore(env: NodeJS.ProcessEnv = process.env): EvidenceStore {
  if (cached && env === process.env) return cached;
  const kind = env.EVIDENCE_STORE ?? (env.NODE_ENV === "production" ? "s3" : "local");
  let store: EvidenceStore;
  if (kind === "s3") {
    const { EVIDENCE_S3_ENDPOINT, EVIDENCE_S3_BUCKET, EVIDENCE_S3_ACCESS_KEY_ID, EVIDENCE_S3_SECRET_ACCESS_KEY } = env;
    if (!EVIDENCE_S3_ENDPOINT || !EVIDENCE_S3_BUCKET || !EVIDENCE_S3_ACCESS_KEY_ID || !EVIDENCE_S3_SECRET_ACCESS_KEY) {
      throw new Error("EVIDENCE_STORE=s3 needs EVIDENCE_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY");
    }
    store = new S3EvidenceStore({
      endpoint: EVIDENCE_S3_ENDPOINT,
      region: env.EVIDENCE_S3_REGION ?? "auto",
      bucket: EVIDENCE_S3_BUCKET,
      accessKeyId: EVIDENCE_S3_ACCESS_KEY_ID,
      secretAccessKey: EVIDENCE_S3_SECRET_ACCESS_KEY,
    });
  } else {
    if (env.NODE_ENV === "production") throw new Error("The local evidence store is for development only");
    const secret = env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("BETTER_AUTH_SECRET is needed to sign local evidence URLs");
    store = new LocalEvidenceStore(path.resolve(/*turbopackIgnore: true*/ env.EVIDENCE_LOCAL_DIR ?? ".evidence-store"), secret);
  }
  if (env === process.env) cached = store;
  return store;
}
