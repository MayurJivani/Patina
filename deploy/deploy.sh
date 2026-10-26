#!/bin/sh
# Ship Patina to Jinx. The box keeps its own checkout at /opt/apps/Patina, so the
# unit of deployment is a fast-forward of that checkout, a rebuild in place and
# a restart of the `patina` systemd unit. Nothing is copied from here, which is
# what makes a deploy from CI and a deploy from a laptop the same operation.
#
# --ff-only rather than a plain pull: if the checkout on the box has drifted,
# stop and say so rather than quietly merging something nobody wrote.
#
# The disk on Jinx is failing, so writes are kept down: the npm cache is on
# tmpfs (/tmp/npm, set in ~/.npmrc there) and dev dependencies are pruned once
# the build is done. Runtime config is /etc/apps/patina.env, read by the unit.
set -eu
ssh ssh.futile.studio '
  set -eu
  cd /opt/apps/Patina
  git pull --ff-only
  HUSKY=0 npm ci --no-audit --no-fund
  npm run build
  npm prune --omit=dev
  # The box npm is older than the one that wrote the lockfile, and prune
  # rewrites it to its own dialect. Put it back so the next pull fast-forwards.
  git checkout -- package-lock.json
  sudo -n systemctl restart patina

  # Come back and check, rather than trusting that a restart meant "serving".
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4323/ || true)
  case "$code" in
    2*|3*) echo "patina: serving on 127.0.0.1:4323 (HTTP $code)" ;;
    *) echo "patina: not serving (HTTP $code)"; sudo -n journalctl -u patina -n 30 --no-pager; exit 1 ;;
  esac
'
echo "patina: deployed to https://patina.futile.studio"
