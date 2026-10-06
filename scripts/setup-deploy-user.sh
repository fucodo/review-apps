#!/usr/bin/env bash
# Create the deploy user for GitLab CI (DOCKER_HOST=ssh://...) with a key that
# can only open the Docker API tunnel (no shell).
#
#   sudo ./scripts/setup-deploy-user.sh <name-or-ip>[,<name-or-ip>...] [ssh-port]
#   e.g. sudo ./scripts/setup-deploy-user.sh tests.example.org,10.10.10.124
#
# Re-running rotates the key (the old entry with the same comment is replaced).
set -euo pipefail

HOSTS="${1:?Usage: $0 <name-or-ip>[,<name-or-ip>...] [ssh-port]}"
SSH_PORT="${2:-22}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
KEY_COMMENT="${KEY_COMMENT:-gitlab-review-deploy}"

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
getent group docker >/dev/null || { echo "Group 'docker' missing – is Docker installed?" >&2; exit 1; }
[[ -r /etc/ssh/ssh_host_ed25519_key.pub ]] || { echo "No ed25519 host key found." >&2; exit 1; }

KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT

if ! id "$DEPLOY_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
SSH_DIR="$HOME_DIR/.ssh"
AUTH="$SSH_DIR/authorized_keys"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SSH_DIR"
touch "$AUTH"

ssh-keygen -q -t ed25519 -N "" -C "$KEY_COMMENT" -f "$KEY_DIR/review_deploy"

awk -v c="$KEY_COMMENT" '$NF != c' "$AUTH" > "$AUTH.tmp"
printf 'restrict,command="docker system dial-stdio" %s\n' "$(cat "$KEY_DIR/review_deploy.pub")" >> "$AUTH.tmp"
mv "$AUTH.tmp" "$AUTH"
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"
chmod 600 "$AUTH"

# known_hosts line straight from the host key, valid for every given name/IP
HOST_LIST=""
IFS=',' read -ra NAMES <<< "$HOSTS"
for n in "${NAMES[@]}"; do
  [[ "$SSH_PORT" == "22" ]] && entry="$n" || entry="[$n]:$SSH_PORT"
  HOST_LIST="${HOST_LIST:+$HOST_LIST,}$entry"
done
KNOWN_HOSTS="$HOST_LIST $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"

TARGET="$DEPLOY_USER@${NAMES[0]}"
[[ "$SSH_PORT" != "22" ]] && TARGET="$TARGET:$SSH_PORT"

cat <<EOF

================================================================
 GitLab → Settings → CI/CD → Variables
================================================================

REVIEW_SSH_TARGET  (Variable)
$TARGET

REVIEW_SSH_KNOWN_HOSTS  (Variable)
$KNOWN_HOSTS

REVIEW_SSH_KEY  (File, Protected: off) – paste everything between the lines,
including BEGIN/END and the final newline:
----------------------------------------------------------------
$(cat "$KEY_DIR/review_deploy")
----------------------------------------------------------------

Fingerprint (compare with the "Using key" line in the CI job):
$(ssh-keygen -lf "$KEY_DIR/review_deploy.pub")

The private key is deleted now and only exists in this output.
EOF
