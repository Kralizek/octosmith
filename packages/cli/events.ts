import type { EventDocument } from "@hooksmith/core";
import type { ApplyItemReport, RepositoryReport } from "@octosmith/octosmith";
import type { ApplyMode } from "./apply.ts";

/** Describes repository event data. */
export interface RepositoryEventData {
  readonly items: readonly ApplyItemReport[];
  readonly error?: string;
}

export function toRepositoryEvent(
  organization: string,
  mode: ApplyMode,
  report: RepositoryReport,
  timestamp: Date = new Date(),
): EventDocument<RepositoryEventData> {
  return {
    type: mode === "plan" ? "resource.planned" : "resource.applied",
    timestamp: timestamp.toISOString(),
    source: {
      kind: "github.organization",
      id: organization,
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

/** Describes event output. */
export interface EventOutput {
  write(event: EventDocument): Promise<void>;
  close(): void;
}

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
