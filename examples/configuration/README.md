# Example OctoSmith configuration

This directory is a design fixture for the OctoSmith configuration model.

The filesystem acts as the registry:

- `octosmith.yml` defines the deployment scope.
- `base.yml` applies to every repository in scope.
- exactly one file under `types/` should match a repository.
- zero or more files under `traits/` may match a repository.
- `overrides/<repository>.yml` is an explicit repository-specific escape hatch.
- `templates/` contains content copied into managed repositories.

The effective desired state for a repository is composed as:

```text
base
  + type
  + matching traits
  + repository override
```

Names used in this example are intentionally generic and do not represent any
specific organization.
