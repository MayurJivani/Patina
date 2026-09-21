#!/bin/sh
# One-time setup on a box that already terminates TLS for other sites (Jinx runs
# a system cloudflared in front of a system Caddy): the site block that puts the
# public hostname in front of the relay container. Needs root, and is the only
# step that does — the container itself comes up from docker-compose.tunnel.yml
# as an ordinary member of the docker group.
#
# Re-runnable: it replaces any previous patina block rather than appending, so
# editing deploy/patina.caddy and running this again is the way to change it.
#
# This is only half the route. The tunnel's ingress for patina.futile.studio
# must point at http://localhost:80 in the Cloudflare dashboard, or requests
# never reach Caddy at all — that part cannot be done from the box.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
CADDY=/etc/caddy/Caddyfile

cp "$CADDY" "$CADDY.bak"

python3 - "$CADDY" "$HERE/patina.caddy" <<'PY'
import pathlib, re, sys

caddy, block = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
# Drop any existing patina block. It nests one level (reverse_proxy), so match
# to a line-initial "}" — the validate below is the backstop.
text = re.sub(r"\n*http://patina\.futile\.studio\s*\{.*?\n\}\n?", "\n", caddy.read_text(), flags=re.S)
caddy.write_text(text.rstrip() + "\n\n" + block.read_text())
PY

# Validate before reloading: this file serves every other site on the box.
caddy validate --adapter caddyfile --config "$CADDY"
systemctl reload caddy

echo "patina: Caddyfile updated and reloaded (backup at $CADDY.bak)"
