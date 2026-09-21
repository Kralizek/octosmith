import type { Config } from "jsr:@hooksmith/core";
import {
  all,
  eventType,
  logEvent,
  subjectKind,
} from "jsr:@hooksmith/standard";

export default {
  routes: [{
    name: "octosmith-applied-repositories",
    when: all(
      eventType("resource.applied"),
      subjectKind("github.repository"),
    ),
    listeners: [logEvent()],
  }],
} satisfies Config;
