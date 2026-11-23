import { GitHubRequestError } from "./github/client.ts";

/**
 * Where the GitHub credential came from, when the caller knows it.
 *
 * Remediation is only tailored to a source the caller reports; otherwise it
 * stays generic because GitHub cannot tell which mechanism supplied a token.
 */
export type GitHubCredentialSource = "explicit" | "environment" | "gh";

const WORKFLOW_DIRECTORY = ".github/workflows/";

// GitHub's own refusal text for workflow-file changes, from Git pushes and
// REST/GraphQL writes alike.
const WORKFLOW_REFUSAL =
  /refusing to allow .{1,80}? to create or update workflow/i;

/** Whether GitHub's diagnostic explicitly refuses workflow-file changes. */
export function isWorkflowPermissionRefusal(diagnostic: string): boolean {
  return WORKFLOW_REFUSAL.test(diagnostic);
}

/** Describe how to grant workflow-file permission without exposing credentials. */
export function workflowPermissionRemediation(
  source?: GitHubCredentialSource,
): string {
  const generic =
    "Use a credential that can modify workflow files: classic personal access tokens and OAuth tokens need the `workflow` scope; fine-grained tokens and GitHub App installations need Workflows: write.";
  switch (source) {
    case "gh":
      return generic +
        " The token came from the GitHub CLI; run `gh auth refresh -h github.com -s workflow`.";
    case "environment":
      return generic +
        " The token came from GITHUB_TOKEN; update the token supplied there (the token GitHub Actions generates automatically cannot modify workflow files).";
    case "explicit":
      return generic + " Update the explicitly supplied token.";
    default:
      return generic;
  }
}

/**
 * Explain a REST file-delivery failure that touched workflow files.
 *
 * GitHub reports missing workflow permission on REST writes either with an
 * explicit refusal or as a bare 404 on the write request. A 404 alone is
 * ambiguous, so only non-GET requests are considered and the cause is only
 * stated as confirmed when the refusal text or the OAuth scopes reported with
 * the response support it. Other failures, including unrelated 403s,
 * return undefined so existing handling applies.
 */
export function describeWorkflowWriteFailure(
  error: unknown,
  paths: readonly string[],
  source?: GitHubCredentialSource,
): string | undefined {
  if (!(error instanceof GitHubRequestError)) return undefined;
  const workflows = paths.filter((path) => path.startsWith(WORKFLOW_DIRECTORY));
  if (workflows.length === 0) return undefined;

  let evidence: string;
  if (isWorkflowPermissionRefusal(error.details?.message ?? error.body)) {
    evidence = "GitHub refused the workflow-file change (HTTP " +
      error.status + ")";
  } else if (
    error.status !== 404 || error.method === undefined ||
    error.method === "GET" || error.oauthScopes?.includes("workflow")
  ) {
    return undefined;
  } else if (error.oauthScopes !== undefined) {
    evidence =
      "GitHub returned HTTP 404 and the token's OAuth scopes do not include `workflow`";
  } else {
    evidence =
      "GitHub returned HTTP 404, which is how it reports missing workflow-file permission, but the response does not confirm the cause";
  }
  return "Managed-file delivery changes workflow files (" +
    workflows.join(", ") + "); " + evidence + ". " +
    workflowPermissionRemediation(source);
}
