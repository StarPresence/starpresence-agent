# CircleCI release boundary

Every pipeline tests the CLI on the supported Node matrix. Only an exact
GitHub App `push` pipeline for `StarPresence/starpresence-agent` `main` can release.

The candidate must reproduce the immutable SHA-256 in
`release/cli-<version>.json`, whose canary record must prove that those exact
bytes passed the read-only production canary and that its temporary credential
was revoked. The protected publish job receives only that tarball.

The `npm-trusted-publishing` context must contain no npm or StarReview secrets.
Restrict it to this project and:

```
pipeline.git.branch == "main" and
pipeline.config.ref == "refs/heads/main" and
pipeline.event.name == "push" and
not job.ssh.enabled
```

Configure npm trusted publishing for the CircleCI organization, project,
pipeline definition, VCS origin, and context UUID. The workflow requests a
short-lived npm OIDC token only for an unpublished version.
