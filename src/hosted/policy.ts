import { readFileSync, statSync } from "node:fs";
import { z } from "zod/v4";

export type Role = "admin" | "editor" | "viewer";

/** An authenticated hosted user after policy resolution. */
export interface Principal {
  email: string;
  role: Role;
  stores: "*" | string[];
}

const RuleSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
  stores: z.union([z.literal("*"), z.array(z.string().min(1).max(64)).max(500)])
}).strict();

const PolicySchema = z.object({
  users: z.record(z.string().min(3), RuleSchema).default({}),
  domains: z.record(z.string().min(1), RuleSchema).default({})
}).strict();

export type PolicyDocument = z.infer<typeof PolicySchema>;

/**
 * Maps a verified email to a role and store allowlist.
 * An exact user entry wins over a domain entry. Anyone not listed gets no access.
 */
export class Policy {
  private readonly users = new Map<string, z.infer<typeof RuleSchema>>();
  private readonly domains = new Map<string, z.infer<typeof RuleSchema>>();

  constructor(document: unknown) {
    const parsed = PolicySchema.parse(document);
    for (const [email, rule] of Object.entries(parsed.users)) this.users.set(email.trim().toLowerCase(), rule);
    for (const [domain, rule] of Object.entries(parsed.domains)) this.domains.set(domain.trim().toLowerCase(), rule);
  }

  resolve(email: string): Principal | null {
    const normalized = email.trim().toLowerCase();
    const at = normalized.lastIndexOf("@");
    if (at < 1) return null;
    const rule = this.users.get(normalized) ?? this.domains.get(normalized.slice(at + 1));
    if (!rule) return null;
    return { email: normalized, role: rule.role, stores: rule.stores === "*" ? "*" : [...rule.stores] };
  }
}

export interface PolicySource {
  current(): Policy;
}

/**
 * Reads the policy file and re-reads it when its modification time changes,
 * so removing a user takes effect on their next request without a restart.
 * A policy file that becomes unreadable or invalid fails closed (nobody has access).
 */
export class FilePolicySource implements PolicySource {
  private cached?: { mtimeMs: number; size: number; policy: Policy };
  private static readonly EMPTY = new Policy({});

  constructor(private readonly path: string) {
    // Fail fast at startup if the file is missing or invalid.
    this.cached = this.read();
  }

  private read(): { mtimeMs: number; size: number; policy: Policy } {
    const stat = statSync(this.path);
    const policy = new Policy(JSON.parse(readFileSync(this.path, "utf8")));
    return { mtimeMs: stat.mtimeMs, size: stat.size, policy };
  }

  current(): Policy {
    try {
      const stat = statSync(this.path);
      if (!this.cached || this.cached.mtimeMs !== stat.mtimeMs || this.cached.size !== stat.size) {
        this.cached = this.read();
      }
      return this.cached.policy;
    } catch (error) {
      process.stderr.write(`Policy file ${this.path} could not be loaded; denying all access: ${error instanceof Error ? error.message : String(error)}\n`);
      this.cached = undefined;
      return FilePolicySource.EMPTY;
    }
  }
}

export function staticPolicy(document: unknown): PolicySource {
  const policy = new Policy(document);
  return { current: () => policy };
}
