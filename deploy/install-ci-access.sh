#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
source_dir=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)
id skillludo-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash skillludo-deploy
install -d -o root -g root -m 755 /home/skillludo-deploy /home/skillludo-deploy/.ssh
install -o root -g root -m 755 "$source_dir/deploy/ci-receiver.sh" /usr/local/sbin/skillludo-ci-receiver
python3 - <<'PY'
from pathlib import Path
key = Path('/tmp/skillludo-ci.pub').read_text().strip()
if not key.startswith('ssh-ed25519 ') or '\n' in key: raise SystemExit('Expected a single Ed25519 public key')
prefix = r'restrict,command="/usr/bin/sudo /usr/local/sbin/skillludo-ci-receiver \"$SSH_ORIGINAL_COMMAND\"" '
Path('/home/skillludo-deploy/.ssh/authorized_keys').write_text(prefix + key + '\n')
Path('/etc/sudoers.d/skillludo-deploy').write_text('skillludo-deploy ALL=(root) NOPASSWD: /usr/local/sbin/skillludo-ci-receiver *\n')
PY
chmod 644 /home/skillludo-deploy/.ssh/authorized_keys
chmod 440 /etc/sudoers.d/skillludo-deploy
visudo -cf /etc/sudoers.d/skillludo-deploy
echo 'Restricted CI deployment access installed.'
