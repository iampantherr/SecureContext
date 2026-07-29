/**
 * Claim verification — check a delivery claim against the repository, not against
 * the claimant's confidence.
 *
 * WHY THIS EXISTS
 *
 * Measured on the live A2A project: the acceptance gate reported PASS 42/42 on
 * FIVE submissions across two slices. Three of those were then failed by a QA
 * literal close-out — endpoints hanging indefinitely, an endpoint answering HTTP
 * 200 with fabricated empty data, and an event loop still blocking after a
 * 250-call sweep. The gate's detection rate on the failures that mattered was
 * zero, because it never exercised the condition the work was written for.
 *
 * A MERGE broadcast is a CLAIM. It asserts a commit, a file list, and usually a
 * test count. Nothing checked any of it. So an agent could deliver
 * "MERGED at abc1234, 21/21 tests pass, files: [...]" and be believed, whether or
 * not the commit existed, the files were committed, or the tests were ever run.
 *
 * WHAT THIS DOES, AND DELIBERATELY DOES NOT
 *
 * It separates a claim's assertions into three buckets and never conflates them:
 *
 *   VERIFIED    — checked against the repo and true (commit exists; file is
 *                 tracked at that commit; named evidence file present).
 *   REFUTED     — checked and FALSE. This is the case worth existing for: a
 *                 claimed file that is not committed is the exact defect behind
 *                 the standing MERGE-files rule.
 *   UNVERIFIABLE — cannot be checked from the repo alone (a test count, a latency
 *                 figure, "no regressions"). Reported as unverifiable, NEVER as
 *                 verified. Silently upgrading an unverifiable claim to a pass is
 *                 how a gate comes to report 42/42 on broken work.
 *
 * The distinction matters more than the checking. A claim that cannot be checked
 * is not thereby true, and a verifier that hides that is worse than none.
 */
import { execFileSync } from "node:child_process";

export type ClaimStatus = "verified" | "refuted" | "unverifiable";

export interface ClaimCheck {
  assertion: string;
  status: ClaimStatus;
  detail: string;
}

export interface ClaimVerdict {
  /** True only when nothing was refuted. Unverifiable items do NOT block. */
  ok: boolean;
  refuted: number;
  unverifiable: number;
  verified: number;
  checks: ClaimCheck[];
  /** Operator/agent-facing summary; "" when everything checkable passed and nothing was unverifiable. */
  notice: string;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? e).trim().slice(0, 200) };
  }
}

/** Numeric/behavioural assertions a repo cannot settle. Reported, never passed. */
const UNVERIFIABLE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\b\d+\s*\/\s*\d+\s*(tests?|specs?|checks?|ACs?)\b/i, what: "a test/AC count" },
  { re: /\b(all|every)\s+(tests?|ACs?|criteria)\b/i,          what: "a blanket pass claim" },
  { re: /\b\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/i,              what: "a latency figure" },
  { re: /\bno\s+(regressions?|breakage|failures?)\b/i,        what: "an absence-of-regression claim" },
  { re: /\b(green|passing|verified|confirmed)\b/i,            what: "a self-assessment" },
];

/**
 * Verify what a repository can settle about a delivery claim.
 *
 * `repoPath` must be a git working tree. When it is not, every repo-backed check
 * degrades to UNVERIFIABLE rather than silently passing — the whole point.
 */
export function verifyClaim(
  repoPath: string,
  claim: { summary?: string; files?: string[]; commit?: string; evidenceFile?: string }
): ClaimVerdict {
  const checks: ClaimCheck[] = [];
  const isRepo = git(repoPath, ["rev-parse", "--is-inside-work-tree"]).ok;

  if (!isRepo) {
    checks.push({
      assertion: "repository is inspectable",
      status: "unverifiable",
      detail: `'${repoPath}' is not a git work tree, so no claim about commits or committed files ` +
              `can be checked here. Treat every repo-backed assertion below as UNCHECKED.`,
    });
  }

  // ── commit exists ──────────────────────────────────────────────────────────
  if (claim.commit) {
    const c = claim.commit.trim();
    if (!isRepo) {
      checks.push({ assertion: `commit ${c} exists`, status: "unverifiable", detail: "no repo to check against." });
    } else {
      const r = git(repoPath, ["cat-file", "-e", `${c}^{commit}`]);
      checks.push(r.ok
        ? { assertion: `commit ${c} exists`, status: "verified", detail: "found in the repository." }
        : { assertion: `commit ${c} exists`, status: "refuted",
            detail: `no such commit. The claim names a commit that is not in this repository.` });
    }
  }

  // ── each claimed file is COMMITTED (not merely present on disk) ────────────
  for (const f of claim.files ?? []) {
    const path = String(f).trim();
    if (!path) continue;
    if (!isRepo) {
      checks.push({ assertion: `${path} is committed`, status: "unverifiable", detail: "no repo to check against." });
      continue;
    }
    // Tracked at the claimed commit when one is given, else at HEAD.
    const ref = claim.commit?.trim() || "HEAD";
    const r = git(repoPath, ["ls-tree", "-r", "--name-only", ref, "--", path]);
    const tracked = r.ok && r.out.length > 0;
    if (tracked) {
      checks.push({ assertion: `${path} is committed at ${ref}`, status: "verified", detail: "tracked at that ref." });
    } else {
      // Distinguish "not committed" from "does not exist at all" — different fixes.
      const onDisk = git(repoPath, ["status", "--porcelain", "--", path]);
      const detail = onDisk.ok && onDisk.out.length > 0
        ? `present in the working tree but NOT committed at ${ref}. Produced-but-not-committed is not delivered.`
        : `not tracked at ${ref} and not visible as a working-tree change. The claim lists a file that is not there.`;
      checks.push({ assertion: `${path} is committed at ${ref}`, status: "refuted", detail });
    }
  }

  // ── named evidence artefact ───────────────────────────────────────────────
  if (claim.evidenceFile) {
    const ef = String(claim.evidenceFile).trim();
    if (!isRepo) {
      checks.push({ assertion: `evidence ${ef} committed`, status: "unverifiable", detail: "no repo to check against." });
    } else {
      const ref = claim.commit?.trim() || "HEAD";
      const r = git(repoPath, ["ls-tree", "-r", "--name-only", ref, "--", ef]);
      checks.push(r.ok && r.out.length > 0
        ? { assertion: `evidence ${ef} committed at ${ref}`, status: "verified", detail: "tracked at that ref." }
        : { assertion: `evidence ${ef} committed at ${ref}`, status: "refuted",
            detail: `not committed. A claim is not evidence; the artefact has to exist.` });
    }
  }

  // ── assertions the repo cannot settle ─────────────────────────────────────
  const summary = String(claim.summary ?? "");
  for (const { re, what } of UNVERIFIABLE_PATTERNS) {
    const m = summary.match(re);
    if (m) {
      checks.push({
        assertion: `"${m[0]}"`,
        status: "unverifiable",
        detail: `${what} cannot be settled from the repository. It is not refuted — it is UNCHECKED. ` +
                `Commit the program's own output as an artefact if it needs to count as evidence.`,
      });
    }
  }

  const refuted      = checks.filter((c) => c.status === "refuted").length;
  const unverifiable = checks.filter((c) => c.status === "unverifiable").length;
  const verified     = checks.filter((c) => c.status === "verified").length;

  const parts: string[] = [];
  if (refuted > 0) {
    parts.push(`[!] ${refuted} assertion(s) in this claim are REFUTED by the repository:`);
    for (const c of checks.filter((x) => x.status === "refuted")) parts.push(`  - ${c.assertion}: ${c.detail}`);
  }
  if (unverifiable > 0) {
    parts.push(`[?] ${unverifiable} assertion(s) CANNOT be checked from the repo (unchecked, not passed):`);
    for (const c of checks.filter((x) => x.status === "unverifiable")) parts.push(`  - ${c.assertion}: ${c.detail}`);
  }

  return { ok: refuted === 0, refuted, unverifiable, verified, checks, notice: parts.join("\n") };
}
