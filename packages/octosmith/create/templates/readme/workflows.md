## Operating model

1. Open a pull request with configuration changes.
2. The OctoSmith validate workflow checks the proposed configuration offline,
   without organization credentials or GitHub API access.
3. Review and merge the pull request.
4. The OctoSmith apply workflow applies the desired state.

Use `octosmith plan` separately when a trusted operator wants to inspect live
GitHub drift before merge. Planning requires read access to the configured
organization; validation does not.
