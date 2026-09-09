#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/skillludo-ci-receiver.
# A dedicated SSH key invokes ONLY this command through sudo.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
requested=${1:-}
if [[ ! "$requested" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deploy <40-character commit SHA> is allowed.' >&2
  exit 64
fi
revision=${BASH_REMATCH[1]}
image="docker.io/skillludo/server:sha-$revision"
install -d -m 700 /opt/skillludo/releases
exec 9>/opt/skillludo/releases/deploy.lock
flock -w 600 9
archive=$(mktemp /opt/skillludo/releases/image.XXXXXX.tar.gz)
trap 'rm -f -- "$archive"' EXIT
# Bound disk use of the authenticated upload to 300 MiB; no caller-controlled paths.
head -c 314572801 > "$archive"
[[ $(stat -c %s "$archive") -le 314572800 ]] || { echo 'Image exceeds upload limit.' >&2; exit 65; }
gzip -t "$archive"
k3s ctr images import --no-unpack "$archive" >/dev/null
k3s ctr images ls -q | grep -Fx "$image" >/dev/null
previous=$(kubectl -n skillludo get deployment server -o jsonpath='{.spec.template.spec.containers[0].image}')
rollback() {
  echo "Deployment failed; restoring previous image: $previous" >&2
  kubectl -n skillludo set image deployment/server "server=$previous"
  kubectl -n skillludo rollout status deployment/server --timeout=180s
}
kubectl -n skillludo set image deployment/server "server=$image"
if ! kubectl -n skillludo rollout status deployment/server --timeout=180s; then rollback; exit 1; fi
if ! kubectl -n skillludo exec deployment/server -- env "EXPECTED_REVISION=$revision" node scripts/smoke.mjs; then rollback; exit 1; fi
printf '%s\n' "$previous" > /opt/skillludo/releases/previous-image
printf '%s\n' "$image" > /opt/skillludo/releases/current-image
echo "Verified deployment: $revision"
