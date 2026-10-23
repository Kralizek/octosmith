import type { CurrentFile, DesiredFile } from "./types.ts";

/** Reserved internal file used to establish a repository's first commit. */
export const BOOTSTRAP_FILE_PATH = ".github/.octosmith-bootstrap";

/** Permanent versioned ownership marker, independent of explanatory wording. */
export const BOOTSTRAP_FILE_MARKER =
  "<!-- octosmith:repository-bootstrap:v1 -->";

/** Permanent closing ownership marker for the reserved bootstrap file. */
export const BOOTSTRAP_FILE_END_MARKER =
  "<!-- /octosmith:repository-bootstrap -->";

/** Recognizable initial content for the internally owned bootstrap file. */
export const BOOTSTRAP_FILE_CONTENT = `${BOOTSTRAP_FILE_MARKER}
# Octosmith Repository Bootstrap

This file was created automatically by Octosmith to initialize
this GitHub repository.

GitHub requires an initial commit before normal Git operations,
including pull requests, can be performed.

This file is temporary and is managed exclusively by Octosmith.

It will be removed automatically through Octosmith's managed-file
reconciliation process.

Until then, it is safe to leave in place.
${BOOTSTRAP_FILE_END_MARKER}
`;

/**
 * Recognize the marker-delimited ownership claim for the entire reserved file.
 * Interior text is disposable, even when edited; markers are not proof of origin.
 */
export function assertBootstrapFileOwned(file: CurrentFile): void {
  const content = file.content.replace(/\r\n?/g, "\n");
  if (
    file.path !== BOOTSTRAP_FILE_PATH ||
    !content.startsWith(BOOTSTRAP_FILE_MARKER + "\n") ||
    !content.endsWith("\n" + BOOTSTRAP_FILE_END_MARKER + "\n")
  ) {
    throw new Error(
      "Reserved bootstrap file conflict at " + BOOTSTRAP_FILE_PATH +
        ": content is not recognized as Octosmith-owned. Move or remove the conflicting file manually; Octosmith will not overwrite or delete it.",
    );
  }
}

/** Reject user-managed declarations of the reserved internal lifecycle resource. */
export function assertNoBootstrapFileDeclarations(
  files: readonly DesiredFile[],
): void {
  if (files.some((file) => file.path === BOOTSTRAP_FILE_PATH)) {
    throw new Error(
      "Reserved path " + BOOTSTRAP_FILE_PATH +
        " is managed exclusively by Octosmith and cannot be declared in a template",
    );
  }
}
