# review-apps

Shared infrastructure for review environments on a single Docker host – one per merge request, plus long-lived deployments of protected branches (e.g. `main`, `develop`):

- **Traefik v3** – routing via Docker labels, Let's Encrypt certificates via the TLS-ALPN challenge (no DNS API required)
- **Access control** – `none`, `basic` (htpasswd) or `oidc` (GitLab login via oauth2-proxy), applied centrally as the `review-auth@file` middleware
- **Dashboard** – lists all protected branch deployments and MR environments (in separate sections), including sub-services (Mailpit, DB, …), based on their labels
- **Image cleanup** – nightly `docker image prune` for old MR images

The stacks themselves belong in the respective application repository (see `examples/docker-compose.review.yml`, the same file serves both deployment types) and are deployed by GitLab CI via `DOCKER_HOST=ssh://…`.

## Requirements

- Linux host with Docker Engine and the Compose plugin (`docker compose version`)
- Ports **80** and **443** reachable from the internet (for the TLS challenge)
- DNS: `*.<BASE_DOMAIN>` (wildcard A record) points to the host
- The host can reach the GitLab container registry (add an internal `/etc/hosts` entry if necessary)

## Installation

```bash
git clone <repo-url> /opt/review-infra
cd /opt/review-infra
sudo ./install.sh          # creates .env
nano .env                  # BASE_DOMAIN, DASHBOARD_HOST, ACME_EMAIL, AUTH_MODE
sudo ./install.sh          # installs and starts everything
```

`install.sh` is idempotent – running it again applies changes to `.env`, updates images, rebuilds the dashboard and restarts changed services.

**Tip:** For the initial setup, configure the Let's Encrypt staging CA in `.env` so failed attempts don't count against the rate limit. The limit (50 certificates/week) applies to the entire registered domain, including production. Afterwards switch back to the production CA and empty `acme/acme.json`.

## Access control

Set `AUTH_MODE` in `.env` and run `./install.sh` again. The MR stacks don't need to be redeployed – they only reference `review-auth@file`.

### `basic`

```bash
sudo ./install.sh add-user kay       # prompts for the password
sudo ./install.sh remove-user kay
./install.sh users
```

Changes take effect immediately, without a restart.

### `oidc` (GitLab)

1. Create an application in GitLab (Group → Settings → Applications):
   - Redirect URI: `https://<AUTH_HOST>/oauth2/callback`
   - Confidential: yes
   - Scopes: `openid`, `email`, `profile`
2. In `.env`: `AUTH_MODE=oidc`, `AUTH_HOST`, `GITLAB_URL`, `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `GITLAB_GROUPS`
3. `sudo ./install.sh` – the cookie secret is generated automatically.

A single login is valid for all MR environments and the dashboard (cookie on `.<BASE_DOMAIN>`). Only members of the groups listed in `GITLAB_GROUPS` get access.

## Deploy user for GitLab CI

```bash
sudo ./scripts/setup-deploy-user.sh tests.example.org,10.10.10.124
```

Creates the user `deploy` (member of the `docker` group) and generates a key that is restricted via `authorized_keys` to `docker system dial-stdio` – it can only open the Docker API tunnel, not a shell. All given names/IPs end up in the `known_hosts` line. The output contains the three CI variables:

| Variable | Type |
|---|---|
| `REVIEW_SSH_TARGET` | Variable |
| `REVIEW_SSH_KNOWN_HOSTS` | Variable |
| `REVIEW_SSH_KEY` | File, *Protected* off (MR branches are usually not protected; protected branch jobs can use it as well) |

Running it again rotates the key.

## Label convention for review stacks

Complete example: `examples/docker-compose.review.yml`.

**Traefik:** Every router needs a unique name (`${STACK}`, `${STACK}-mail`, …), the `websecure` entrypoint and the `review-auth@file` middleware. Containers with web access are attached to the external `traefik` network.

**Dashboard:**

| Label | Where | Meaning |
|---|---|---|
| `review.type` | all containers of the stack | `mr` (default) or `branch` (protected branch deployment) |
| `review.project` | all containers of the stack | GitLab project path (`${CI_PROJECT_PATH}`); together with `review.mr` or `review.branch` it groups the containers, since MR IIDs and branch names are only unique per project |
| `review.mr` | all containers of the stack (`mr`) | MR IID (`${CI_MERGE_REQUEST_IID}`) |
| `review.branch` | all containers of the stack | Branch name (`${CI_COMMIT_REF_NAME}`); groups the containers of `branch` deployments, for `mr` only shown |
| `review.role` | all | `app` (metadata) or `service` (sub-service) |
| `review.title`, `review.commit`, `review.author`, `review.url`, `review.deployed_at` | `app` | Shown in the dashboard |
| `review.mr_url` | `app` (`mr`) | Link of the MR number |
| `review.branch_url`, optional | `app` | Link of the branch name |
| `review.service.name` | `service` | Chip label |
| `review.service.url` | `service`, optional | Turns the chip into a link |
| `review.service.order` | `service`, optional | Sort order |

The dashboard provides the same data in machine-readable form at `/api/environments` (`?format=json` still works): `branches` holds the protected branch deployments, `environments` the MR environments. Both the page and the API accept `?project=<CI_PROJECT_PATH>` to show a single project only. The page itself loads its data exclusively through this API and refreshes every 30 seconds.

**Logo:** `DASHBOARD_LOGO` in `.env` shows a logo in the dashboard header, `DASHBOARD_LOGO_LINK` makes it a link. The logo can be an http(s) URL, a data URI (quote it, because `install.sh` sources `.env` and the `;` would break the line) or plain base64 image data (paste the output of `base64 -w0 logo.png`; the image type is detected automatically). Run `./install.sh` afterwards to apply it.

The logo is also used as favicon (`/icon`, `/favicon.ico`) and app icon (web manifest, `apple-touch-icon`):

- Inline logos (data URI or base64) are served by the dashboard. SVGs are centered on the smallest enclosing square, so wide or tall logos are neither stretched nor cropped.
- URL logos are referenced directly (`/icon` redirects to them) and used as they are.
- iOS does not support SVG touch icons; for a home screen icon on iPhone/iPad use a square PNG (ideally 180×180).

## Protected branch deployments

Protected branches (e.g. `main`, `develop`, `staging`) can be deployed permanently with the same stack file. The deploy job differs from the MR job only in its rule and a few variables:

```yaml
review:branch:
  rules:
    - if: $CI_COMMIT_REF_PROTECTED == "true" && $CI_PIPELINE_SOURCE == "push"
  variables:
    REVIEW_TYPE: branch                                        # → label review.type=branch
    STACK: review-$CI_PROJECT_PATH_SLUG-$CI_COMMIT_REF_SLUG
    REVIEW_HOST: $CI_COMMIT_REF_SLUG-$CI_PROJECT_PATH_SLUG.tests.example.org
  script:
    - docker compose -p "$STACK" -f docker-compose.review.yml up -d   # same as the MR job
  environment:
    name: branch/$CI_COMMIT_REF_NAME
    url: https://$REVIEW_HOST/
```

Every push to the branch redeploys the same stack, so the environment keeps its data. `STACK` and `REVIEW_HOST` must be unique across all projects on the host (a DNS label has at most 63 characters). Branch deployments are not removed automatically – stop them with `docker compose -p <stack> down` when the branch is no longer needed.

## Operations

```bash
./install.sh status                  # infra containers + deployed environments (MR and branch)
docker compose logs -f traefik       # certificate/routing problems
git pull && sudo ./install.sh        # update
```

## Files

| Path | Content | In Git |
|---|---|---|
| `.env` | Configuration and secrets | no |
| `acme/acme.json` | Certificates | no |
| `auth/users.htpasswd` | Basic auth users | no |
| `dynamic/review-auth.yml` | Active auth middleware (generated from `templates/`) | no |
| `templates/` | Middleware templates per auth mode | yes |
| `dashboard/` | Dashboard (Symfony app, built as an image by `install.sh`) | yes |

## Security

- The dashboard reads the Docker API only through `docker-socket-proxy` (only `GET /containers`) on an internal network.
- Traefik itself mounts the Docker socket read-only.
- All MR hostnames appear in the public Certificate Transparency logs – so only use `AUTH_MODE=none` for internal tests.
