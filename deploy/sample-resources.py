#!/usr/bin/env python3
"""Read host/cgroup counters without spawning extra processes inside the game pod."""
import argparse
import json
import signal
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=90)
parser.add_argument('--output', required=True)
args = parser.parse_args()
if not 1 <= args.seconds <= 900:
    raise SystemExit('seconds must be within 1..900')

def command(*args):
    return json.loads(subprocess.check_output(args))

pods = command('kubectl', '-n', 'skillludo', 'get', 'pod', '-l', 'app=skillludo-server', '-o', 'json')
pod = next(p for p in pods['items'] if p['status']['phase'] == 'Running')
container_id = pod['status']['containerStatuses'][0]['containerID'].split('://')[1]
pid = command('k3s', 'crictl', 'inspect', container_id)['info']['pid']
relative = Path(f'/proc/{pid}/cgroup').read_text().strip().split('::')[1]
cgroup = Path('/sys/fs/cgroup') / relative.lstrip('/')

def counters(path):
    return {parts[0].rstrip(':'): int(parts[1]) for line in path.read_text().splitlines() if len(parts := line.split()) >= 2 and parts[1].isdigit()}

samples = []
previous = counters(cgroup / 'cpu.stat')
previous_time = time.monotonic()
stopping = False
def stop(_signum, _frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop)
for _ in range(args.seconds):
    if stopping:
        break
    time.sleep(1)
    now = time.monotonic()
    cpu = counters(cgroup / 'cpu.stat')
    process = counters(Path(f'/proc/{pid}/status'))
    memory = counters(Path('/proc/meminfo'))
    samples.append({'time': time.time(), 'cpuCores': round((cpu['usage_usec'] - previous['usage_usec']) / 1e6 / (now - previous_time), 4), 'rssMiB': round(process['VmRSS'] / 1024, 2), 'cgroupMiB': round(int((cgroup / 'memory.current').read_text()) / 1024**2, 2), 'hostAvailableMiB': round(memory['MemAvailable'] / 1024, 2), 'throttledPeriods': cpu.get('nr_throttled', 0) - previous.get('nr_throttled', 0), 'throttledMs': round((cpu.get('throttled_usec', 0) - previous.get('throttled_usec', 0)) / 1000, 2)})
    previous, previous_time = cpu, now
result = {'pod': pod['metadata']['name'], 'pid': pid, 'samples': samples, 'summary': {'maxCpuCores': max(s['cpuCores'] for s in samples), 'meanCpuCores': round(sum(s['cpuCores'] for s in samples) / len(samples), 4), 'maxRssMiB': max(s['rssMiB'] for s in samples), 'minHostAvailableMiB': min(s['hostAvailableMiB'] for s in samples), 'throttledPeriods': sum(s['throttledPeriods'] for s in samples)}}
Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result['summary']))
