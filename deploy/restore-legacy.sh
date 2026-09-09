#!/usr/bin/env bash
# Operator action: pause the SkillLudo GitHub workflow before running this.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
snapshot=$(cat /opt/skillludo/backups/legacy-snapshot-path)
[[ "$snapshot" == /opt/skillludo/backups/edu-before-skillludo-* ]] || exit 64
test -s "$snapshot/replicas.json"
test -s "$snapshot/ingress.json"
kubectl -n skillludo scale deployment/server --replicas=0
kubectl -n skillludo scale statefulset/mysql --replicas=0
kubectl -n skillludo delete ingress server --ignore-not-found
python3 - "$snapshot" <<'PY'
import json, subprocess, sys
from pathlib import Path
snapshot = Path(sys.argv[1])
items = json.loads((snapshot / 'replicas.json').read_text())['items']
for item in sorted(items, key=lambda item: item['kind'] != 'StatefulSet'):
    if item['metadata']['namespace'] != 'edu-platform-prod': raise SystemExit('Unexpected namespace')
    subprocess.run(['kubectl','-n','edu-platform-prod','scale',item['kind'].lower()+'/'+item['metadata']['name'],'--replicas='+str(item['spec']['replicas'])], check=True)
ingress = json.loads((snapshot / 'ingress.json').read_text())
ingress.pop('status', None)
for key in ['resourceVersion','uid','creationTimestamp','managedFields','generation']:
    ingress['metadata'].pop(key, None)
subprocess.run(['kubectl','apply','-f','-'], input=json.dumps(ingress), text=True, check=True)
PY
kubectl -n edu-platform-prod wait --for=condition=Available deployment --all --timeout=240s
echo 'Legacy replicas and ingress restored using retained original volumes.'
