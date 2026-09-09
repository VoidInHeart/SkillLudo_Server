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
archive=$(mktemp /opt/skillludo/releases/runtime.XXXXXX.tar.gz)
staging=$(mktemp -d /opt/skillludo/releases/staging.XXXXXX)
trap 'rm -f -- "$archive"; rm -rf -- "$staging"' EXIT
# Only the compiled application is transferred; the pinned Node base stays cached.
head -c 26214401 > "$archive"
[[ $(stat -c %s "$archive") -le 26214400 ]] || { echo 'Release exceeds upload limit.' >&2; exit 65; }
gzip -t "$archive"
python3 - "$archive" "$staging" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    if len(members) > 50000 or sum(member.size for member in members) > 256 * 1024 * 1024:
        raise SystemExit('Expanded release exceeds limits')
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('Invalid archive entry')
        if path.parts and path.parts[0] not in ('dist', 'node_modules', 'config', 'scripts', 'package.json'):
            raise SystemExit('Unexpected release file')
    archive.extractall(sys.argv[2], members=members, filter='data')
PY
test -f "$staging/dist/index.js"
test -f "$staging/scripts/smoke.mjs"
docker build --network=none --build-arg "GIT_SHA=$revision" -f /opt/skillludo/Runtime.Dockerfile -t "$image" "$staging"
docker save "$image" | k3s ctr images import --no-unpack - >/dev/null
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
