# Example OctoSmith configuration

This directory is a design fixture for the initial OctoSmith configuration
model.

The filesystem acts as the registry:

- `octosmith.yml` defines the deployment scope.
- every file under `templates/` fully describes one repository family.
- `files/` contains content copied into managed repositories.

Every repository in scope is expected to match exactly one template. Templates
are intentionally self-contained, even when that means some duplication.

Names used in this example are generic and do not represent any specific
organization.
