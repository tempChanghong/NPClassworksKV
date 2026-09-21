# Restrictive checkout permissions and failure evidence

The first N1 deployment failed before migrations: the retained image contained
root-owned `0600` source files, including `scripts/npep-config.js`, while the
runtime uses `USER node`. The operator wrapper's `umask 077` applied to Git
checkout as well as private log creation. Building as root masked the problem.

The image now grants read access and directory traversal within `/app`, retaining
root ownership and without granting the runtime user write access. This does not
change host checkout permissions. The Docker context excludes environment files,
`deploy/backups`, `deploy/runtime`, database dumps and archive files before COPY.
Custom private files without these paths/extensions still belong outside the
build context; `.dockerignore` cannot identify arbitrary secrets by content.

`pnpm test:deployment:npep` includes a synthetic restricted-context failure/control
test, fake private-file exclusion checks, and the real Dockerfile built with
restricted source permissions. The latter runs its original startup command
against an isolated temporary PostgreSQL database and checks `/ready`. Tests use
unique names, fake credentials and no production mounts or published ports.

On readiness failure, the updated upgrade driver captures bounded container state
and recent backend/PostgreSQL logs before rollback destroys the failed containers.
It excludes container environment and command arguments. Evidence is stored in a
`0700` runtime subdirectory with `0600` files; known environment secrets and URL
credentials are additionally redacted. Arbitrary application logs may still contain
sensitive information: inspect and redact locally before sharing. Capture failure
does not prevent the existing rollback path.

An upgrade invoked through an **old** checked-out shell driver does not gain the
new failure branch merely because that driver subsequently checks out new code.
The controlled retry needs its own verified driver/wrapper and evidence retention.
Do not pre-checkout the new release before an old driver records its previous refs.
Do not recursively chmod the production checkout, which also holds private files.

These changes do not extend automatic rollback to every build/Compose error or
change database restore rules. N1 remains disabled until separately activated.
