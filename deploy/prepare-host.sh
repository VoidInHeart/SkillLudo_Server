#!/usr/bin/env bash
# One-time operator bootstrap, NOT invoked by the CI deployment key.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
source_dir=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)
install -d -m 700 /opt/skillludo/backups /opt/skillludo/releases
snapshot="/opt/skillludo/backups/edu-before-skillludo-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$snapshot"
kubectl -n edu-platform-prod get deploy,sts,svc,ingress,configmap,secret,pvc,pdb -o yaml > "$snapshot/namespace.yaml"
kubectl -n edu-platform-prod get deploy,sts -o json > "$snapshot/replicas.json"
kubectl -n edu-platform-prod get ingress edu-platform -o json > "$snapshot/ingress.json"
kubectl get pv -o yaml > "$snapshot/persistent-volumes.yaml"
kubectl -n edu-platform-prod scale deploy --all --replicas=0
kubectl -n edu-platform-prod scale sts --all --replicas=0
kubectl -n edu-platform-prod wait --for=delete pod --all --timeout=120s
# Existing MySQL has no root credential in its pod environment. Preserve a cold
# copy of the complete data directory only AFTER its graceful termination.
tar -czf "$snapshot/mysql-files.tar.gz" -C /opt/edu-platform mysql-data
gzip -t "$snapshot/mysql-files.tar.gz"
tar -czf "$snapshot/minio-files.tar.gz" -C /opt/edu-platform minio-data
kubectl -n edu-platform-prod delete ingress edu-platform
printf '%s\n' "$snapshot" > /opt/skillludo/backups/legacy-snapshot-path
kubectl apply -f "$source_dir/deploy/namespace.yaml"
python3 - <<'PY'
import json, secrets, subprocess
result = subprocess.run(['kubectl', '-n', 'skillludo', 'get', 'secret', 'mysql-credentials'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if result.returncode:
    manifest = {'apiVersion':'v1', 'kind':'Secret', 'metadata':{'name':'mysql-credentials','namespace':'skillludo'}, 'type':'Opaque', 'stringData':{'MYSQL_ROOT_PASSWORD':secrets.token_urlsafe(32),'MYSQL_PASSWORD':secrets.token_urlsafe(32)}}
    subprocess.run(['kubectl','create','-f','-'], input=json.dumps(manifest), text=True, check=True, stdout=subprocess.DEVNULL)
    print('Independent production database credentials created (not printed).')
PY
kubectl -n skillludo create configmap mysql-schema --from-file="01-schema.sql=$source_dir/deploy/schema.sql" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$source_dir/deploy/mysql.yaml"
kubectl -n skillludo rollout status statefulset/mysql --timeout=300s
echo "Legacy workloads stopped; original volumes retained. Backup: $snapshot"
