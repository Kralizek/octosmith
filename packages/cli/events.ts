import type { EventDocument } from "@hooksmith/core";
import type {
  ApplyItemReport,
  PullRequestResult,
  RepositoryReport,
} from "@octosmith/octosmith";
import type { ApplyMode } from "./apply.ts";

/** Describes repository event data. */
export interface RepositoryEventData {
  readonly items: readonly ApplyItemReport[];
  readonly error?: string;
}

/** Convert a repository report into a resource event. */
export function toRepositoryEvent(
  owner: string,
  mode: ApplyMode,
  report: RepositoryReport,
  timestamp: Date = new Date(),
  ownerType: "User" | "Organization" = "Organization",
): EventDocument<RepositoryEventData> {
  return {
    type: mode === "plan" ? "resource.planned" : "resource.applied",
    timestamp: timestamp.toISOString(),
    source: {
      kind: ownerType === "User" ? "github.user" : "github.organization",
      id: owner,
    },
    subject: {
      kind: "github.repository",
      id: report.repository,
    },
    metadata: {
      producer: "octosmith",
      status: report.status,
      ...(report.template !== undefined && { template: report.template }),
    },
    data: {
      items: report.items,
      ...(report.error !== undefined && { error: report.error }),
    },
  };
}

/** Convert a successful apply-time PR outcome into a lifecycle event. */
export function toPullRequestEvent(
  owner: string,
  result: PullRequestResult,
  timestamp: Date = new Date(),
  ownerType: "User" | "Organization" = "Organization",
): EventDocument<PullRequestResult> {
  return {
    type: "pull_request." + result.action,
    timestamp: timestamp.toISOString(),
    source: {
      kind: ownerType === "User" ? "github.user" : "github.organization",
      id: owner,
    },
    subject: {
      kind: "github.pull_request",
      id: result.repository + "#" + result.number,
    },
    metadata: { producer: "octosmith" },
    data: result,
  };
}

/** Describes event output. */
export interface EventOutput {
  write(event: EventDocument): Promise<void>;
  close(): void;
}

/** Open a writable destination for NDJSON resource events. */
export async function openEventOutput(path: string): Promise<EventOutput> {
  const file = await Deno.open(path, {
    write: true,
    create: true,
    truncate: true,
  });
  const encoder = new TextEncoder();

  return {
    async write(event) {
      const bytes = encoder.encode(JSON.stringify(event) + "\n");
      let offset = 0;

      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
    },

    close() {
      file.close();
    },
  };
}
