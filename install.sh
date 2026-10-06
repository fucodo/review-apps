#!/usr/bin/env bash
# Review infrastructure: Traefik + dashboard (+ optional GitLab OIDC)
#
#   ./install.sh                 install or update (idempotent)
#   ./install.sh add-user NAME   add/update a basic-auth user (password prompt)
#   ./install.sh remove-user NAME
#   ./install.sh users           list basic-auth users
#   ./install.sh status          show infra containers and deployed MR environments
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

USERS_FILE=auth/users.htpasswd
AUTH_FILE=dynamic/review-auth.yml

info() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed."
  docker compose version >/dev/null 2>&1 || die "docker compose (v2 plugin) is not installed."
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (run as root or as a member of the docker group)."
}

load_env() {
  [[ -f .env ]] || die ".env is missing – run ./install.sh first."
  set -a; . ./.env; set +a
}

set_env_value() {   # set_env_value KEY VALUE – replace or append in .env, keeping the inode
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp"
  else
    cat .env > "$tmp"; printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > .env; rm -f "$tmp"
}

reload_auth() {     # Traefik only watches dynamic/, so touch it to re-read the users file
  [[ -f "$AUTH_FILE" ]] && touch "$AUTH_FILE" || true
}

compose() {
  local profiles=()
  [[ "${AUTH_MODE:-}" == "oidc" ]] && profiles=(--profile oidc)
  docker compose "${profiles[@]}" "$@"
}

cmd_install() {
  require_docker

  if [[ ! -f .env ]]; then
    cp .env.example .env
    chmod 600 .env
    info "Created .env from .env.example."
    echo "    Edit .env (domains, e-mail, AUTH_MODE) and run ./install.sh again."
    exit 0
  fi
  load_env

  [[ -n "${BASE_DOMAIN:-}" && "$BASE_DOMAIN" != "tests.example.org" ]] || die "Set BASE_DOMAIN in .env."
  [[ -n "${DASHBOARD_HOST:-}" ]] || die "Set DASHBOARD_HOST in .env."
  [[ -n "${ACME_EMAIL:-}" && "$ACME_EMAIL" != "ops@example.org" ]] || die "Set ACME_EMAIL in .env."
  case "${AUTH_MODE:-}" in none|basic|oidc) ;; *) die "AUTH_MODE must be none, basic or oidc." ;; esac

  info "Preparing directories"
  mkdir -p acme auth dynamic
  [[ -f acme/acme.json ]] || : > acme/acme.json
  chmod 600 acme/acme.json
  [[ -f "$USERS_FILE" ]] || : > "$USERS_FILE"
  chmod 644 "$USERS_FILE"

  if [[ "$AUTH_MODE" == "oidc" ]]; then
    for v in AUTH_HOST GITLAB_URL GITLAB_CLIENT_ID GITLAB_CLIENT_SECRET; do
      [[ -n "${!v:-}" ]] || die "AUTH_MODE=oidc requires $v in .env."
    done
    [[ -n "${GITLAB_GROUPS:-}" ]] || warn "GITLAB_GROUPS is empty – every user of ${GITLAB_URL} can log in."
    if [[ -z "${OAUTH2_COOKIE_SECRET:-}" ]]; then
      OAUTH2_COOKIE_SECRET=$(head -c 32 /dev/urandom | base64 | tr -- '+/' '-_' | tr -d '\n')
      set_env_value OAUTH2_COOKIE_SECRET "$OAUTH2_COOKIE_SECRET"
      info "Generated OAUTH2_COOKIE_SECRET and stored it in .env"
    fi
  fi

  if [[ "$AUTH_MODE" == "basic" && ! -s "$USERS_FILE" ]]; then
    warn "No basic-auth users yet – add one with: ./install.sh add-user <name>"
  fi

  info "Activating auth mode: $AUTH_MODE"
  cp "templates/review-auth.${AUTH_MODE}.yml" "$AUTH_FILE"

  info "Pulling images"
  compose pull --quiet --ignore-buildable

  info "Building dashboard"
  compose build --pull dashboard

  info "Starting services"
  compose up -d --remove-orphans
  if [[ "$AUTH_MODE" != "oidc" ]]; then
    docker compose --profile oidc rm -sf oauth2-proxy >/dev/null 2>&1 || true
  fi

  if [[ $EUID -eq 0 ]]; then
    info "Installing image cleanup cron (/etc/cron.d/review-infra)"
    cat > /etc/cron.d/review-infra <<'EOF'
# Remove images no longer used by any container (old MR builds)
17 3 * * * root docker image prune -af --filter "until=72h" >/dev/null 2>&1
EOF
    chmod 644 /etc/cron.d/review-infra
  else
    warn "Not running as root – skipped installing the image cleanup cron."
  fi

  cat <<EOF

Done.
  Dashboard:        https://${DASHBOARD_HOST}/
  MR environments:  https://mr-<iid>.${BASE_DOMAIN}/
EOF
  [[ "$AUTH_MODE" == "oidc" ]] && echo "  OIDC callback:    https://${AUTH_HOST}/oauth2/callback  (register in GitLab)"
  echo
  echo "Make sure DNS points *.${BASE_DOMAIN} to this host and ports 80/443 are reachable."
}

cmd_add_user() {
  local user=${1:-} pw pw2 line tmp
  [[ -n "$user" ]] || die "Usage: ./install.sh add-user <name>"
  [[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid user name."
  require_docker
  mkdir -p auth; [[ -f "$USERS_FILE" ]] || : > "$USERS_FILE"

  read -rsp "Password for $user: " pw; echo
  read -rsp "Repeat password: " pw2; echo
  [[ -n "$pw" ]] || die "Empty password."
  [[ "$pw" == "$pw2" ]] || die "Passwords do not match."

  line=$(printf '%s' "$pw" | docker run --rm -i httpd:2.4-alpine htpasswd -niB "$user") \
    || die "Could not generate the password hash."

  tmp=$(mktemp)
  awk -F: -v u="$user" '$1 != u' "$USERS_FILE" > "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  cat "$tmp" > "$USERS_FILE"; rm -f "$tmp"
  reload_auth
  info "User '$user' saved."
}

cmd_remove_user() {
  local user=${1:-} tmp
  [[ -n "$user" ]] || die "Usage: ./install.sh remove-user <name>"
  [[ -f "$USERS_FILE" ]] || die "No users file."
  grep -q "^${user}:" "$USERS_FILE" || die "User '$user' not found."
  tmp=$(mktemp)
  awk -F: -v u="$user" '$1 != u' "$USERS_FILE" > "$tmp"
  cat "$tmp" > "$USERS_FILE"; rm -f "$tmp"
  reload_auth
  info "User '$user' removed."
}

cmd_users() {
  [[ -s "$USERS_FILE" ]] || { echo "(no users)"; return; }
  cut -d: -f1 "$USERS_FILE"
}

cmd_status() {
  require_docker
  load_env
  info "Infrastructure"
  compose ps
  echo
  info "Deployed MR environments"
  docker ps -a --filter label=review.mr --filter label=review.title \
    --format 'table {{.Label "review.mr"}}\t{{.Label "review.branch"}}\t{{.Status}}\t{{.Label "review.url"}}'
}

case "${1:-install}" in
  install)      cmd_install ;;
  add-user)     shift; cmd_add_user "${1:-}" ;;
  remove-user)  shift; cmd_remove_user "${1:-}" ;;
  users)        cmd_users ;;
  status)       cmd_status ;;
  -h|--help|help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Unknown command '$1' – see ./install.sh help" ;;
esac
