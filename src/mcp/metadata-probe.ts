/**
 * TEMPORARY, PRIVACY-PRESERVING PROBE (metadata schema only).
 *
 * Purpose: on the next real MCP request, record ONLY:
 *   - header names (lowercased),
 *   - for Origin/Referer, the host only (never path/query),
 *   - structural key names, JSON-RPC method, and value TYPES.
 *
 * It NEVER records values, tokens, IDs, UUIDs, user content, bodies, or full URLs.
 * It is a one-shot, env-gated no-op unless OPENCODE_BRIDGE_METADATA_PROBE=1.
 * Remove this file and its call site after the investigation.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Request } from "express";

let captured = false;

const URL_HOST_HEADERS = new Set(["origin", "referer", "referrer"]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function schemaOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return "<max-depth>";
  if (Array.isArray(value)) return value.length ? [schemaOf(value[0], depth + 1)] : [];
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = schemaOf(child, depth + 1);
    }
    return out;
  }
  return typeOf(value);
}

function describeRequest(req: Request): Record<string, unknown> {
  const headerNames = Object.keys(req.headers).sort();
  const hosts: Record<string, string> = {};
  for (const name of URL_HOST_HEADERS) {
    const host = hostOf(req.headers[name]);
    if (host) hosts[name] = host;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = (body.params ?? {}) as Record<string, unknown>;
  const method = typeof body.method === "string" ? body.method : undefined;

  const paramKeys = Object.keys(params).sort();
  const argumentKeys =
    params.arguments && typeof params.arguments === "object"
      ? Object.keys(params.arguments as Record<string, unknown>).sort()
      : undefined;

  return {
    at: new Date().toISOString(),
    httpMethod: req.method,
    jsonrpcMethod: method,
    headerNames,
    urlHostHeaders: hosts,
    params: {
      keys: paramKeys,
      protocolVersion: typeOf(params.protocolVersion),
      clientInfo: schemaOf(params.clientInfo),
      _meta: schemaOf(params._meta),
      argumentKeys
    }
  };
}

export async function captureMetadataProbeOnce(req: Request): Promise<void> {
  if (captured) return;
  if (process.env.OPENCODE_BRIDGE_METADATA_PROBE !== "1") return;
  captured = true;
  const out =
    process.env.OPENCODE_BRIDGE_METADATA_PROBE_OUT ??
    join(process.cwd(), "dist", "metadata-probe.json");
  const payload = JSON.stringify(describeRequest(req), null, 2) + "\n";
  await writeFile(out, payload, { encoding: "utf8", mode: 0o600 });
}
