# @octosmith/octosmith

The reusable Octosmith library: configuration and state models, offline
validation, planning, reports, GitHub integration, and control-repository
scaffolding.

## Use the library

```ts
import {
  loadConfigurationDirectory,
  validateConfigurationDirectory,
} from "jsr:@octosmith/octosmith@0";

await validateConfigurationDirectory("./configuration");
const loaded = await loadConfigurationDirectory("./configuration");
```

Validation does not require GitHub access. Planning and execution APIs are
available through the package's [JSR API reference](https://jsr.io/@octosmith/octosmith/doc).

## Scaffold a control repository

```sh
deno create jsr:@octosmith/octosmith@0 github-config -- --organization acme
```

For routine command-line usage, use [`@octosmith/cli`](https://jsr.io/@octosmith/cli).

## Documentation

- [Programmatic API and examples](https://github.com/Kralizek/octosmith/blob/master/docs/library/programmatic-api.md)
- [Repository creation lifecycle](https://github.com/Kralizek/octosmith/blob/master/docs/library/repository-creation.md)
- [Library configuration examples](https://github.com/Kralizek/octosmith/blob/master/docs/library/configuration-model.md)
- [Configuration reference](https://github.com/Kralizek/octosmith/blob/master/docs/configuration.md)
- [Architecture and execution model](https://github.com/Kralizek/octosmith/blob/master/docs/architecture.md)
