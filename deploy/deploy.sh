#!/bin/sh
# Ship Patina to Jinx. The box keeps its own checkout at ~/apps/Patina, so the unit
# of deployment is a fast-forward of that checkout plus a rebuild. Nothing is
# copied from here, which is what makes a deploy from CI and a deploy from a
# laptop the same operation.
#
# --ff-only rather than a plain pull: if the checkout on the box has drifted,
# stop and say so rather than quietly merging something nobody wrote.
#
# Persisted state lives in the patina-data volume and survives a rebuild.
set -eu
ssh ssh.futile.studio '
  set -eu
  cd ~/apps/Patina
  git pull --ff-only
  docker compose -f docker-compose.tunnel.yml up -d --build patina

  # Come back and check, rather than trusting that compose meant "serving".
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4323/ || true)
  case "$code" in
    2*|3*) echo "patina: serving on 127.0.0.1:4323 (HTTP $code)" ;;
    *) echo "patina: not serving (HTTP $code)"; docker compose -f docker-compose.tunnel.yml logs --tail 30 patina; exit 1 ;;
  esac
'
echo "patina: deployed to https://patina.futile.studio"
