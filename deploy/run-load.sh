#!/usr/bin/env bash
# Run explicitly with sudo on the target host, only during an approved load window.
set -euo pipefail
rooms=${1:-25}
seconds=${2:-60}
[[ "$rooms" =~ ^[0-9]+$ && "$seconds" =~ ^[0-9]+$ ]] || exit 64
(( rooms >= 1 && rooms <= 1000 && seconds >= 5 && seconds <= 600 )) || exit 64
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
install -d -m 700 /opt/skillludo/capacity
name="capacity-$rooms-$(date +%s)"
base="/opt/skillludo/capacity/$name"
image=$(kubectl -n skillludo get deployment server -o jsonpath='{.spec.template.spec.containers[0].image}')
python3 /opt/skillludo/sample-resources.py --seconds=900 --output="$base-resources.json" > "$base-summary.json" &
sampler=$!
cleanup() {
  kill -TERM "$sampler" 2>/dev/null || true
  wait "$sampler" || true
  kubectl -n skillludo delete pod "$name" --ignore-not-found --wait=false >/dev/null
}
trap cleanup EXIT
python3 - "$name" "$image" "$rooms" "$seconds" <<'PY' | kubectl apply -f -
import json, sys
name, image, rooms, seconds = sys.argv[1:]
manifest = {'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':'skillludo','labels':{'app':'skillludo-load'}},'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'containers':[{'name':'load','image':image,'imagePullPolicy':'Never','command':['node','scripts/load-test.mjs'],'env':[{'name':'LOAD_URL','value':'ws://server:3000'},{'name':'LOAD_ROOMS','value':rooms},{'name':'LOAD_SECONDS','value':seconds},{'name':'LOAD_STEP_MS','value':'700'}],'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'2','memory':'768Mi'}}}]}}
print(json.dumps(manifest))
PY
deadline=$(( $(date +%s) + seconds + 180 ))
while (( $(date +%s) < deadline )); do
  phase=$(kubectl -n skillludo get pod "$name" -o jsonpath='{.status.phase}')
  [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
  sleep 2
done
kubectl -n skillludo logs "$name" > "$base-result.json"
kill -TERM "$sampler"
wait "$sampler"
cat "$base-result.json"
cat "$base-summary.json"
echo "Evidence: $base"
[[ "$phase" == Succeeded ]]
