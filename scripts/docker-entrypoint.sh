#!/bin/sh
# FNXC:DockerRun 2026-08-23-02:13:
# Optionally start `tailscaled` before the dashboard, because the image shipping the `tailscale` CLI
# is not enough to make the remote-access feature work. Fusion's tunnel spawns a bare
# `tailscale funnel <port>`, which needs a running daemon on the DEFAULT socket; with no daemon it
# dies instantly with "failed to connect to local tailscaled" and exit 1, surfacing in the UI as an
# unexplained process failure (operator report: "starting tailscale tunnel in container is failing
# with process exited 1").
#
# The daemon is OPT-IN via a leading `--tailscale` argument (or `FUSION_TAILSCALE=1`), not on by
# default: most containers never use remote access, and a background daemon they did not ask for is
# a process, a listening socket, and an identity in someone's tailnet. The flag is consumed here and
# STRIPPED from the argument list, so everything after it stays a normal Fusion CLI invocation and
# `docker run fusion --tailscale dashboard --port 8080` behaves exactly like the documented form.
#
# Userspace networking (`--tun=userspace-networking`) is deliberate: it needs neither `NET_ADMIN` nor
# `/dev/net/tun`, so the documented `docker run` keeps working unchanged, and it is sufficient for
# `tailscale serve`/`funnel`, which proxy to a local port rather than route packets. The SOCKS5/HTTP
# proxy listeners are the standard userspace-mode escape hatch for outbound tailnet access, which has
# no route out otherwise.
#
# Startup is BEST-EFFORT and never fails the container: a daemon that will not start must still leave
# the operator with a dashboard, and the tunnel preflight reports the unusable backend by itself.
#
# Login is NOT automated here — `tailscale up` requires an interactive auth URL or an operator's auth
# key, so the daemon comes up logged-out and the operator authenticates once. State lives under
# /var/lib/tailscale, which the image symlinks into /home/node/.tailscale so the documented
# `-v <vol>:/home/node` mount persists that login across container recreates.
set -e

tailscale_enabled="${FUSION_TAILSCALE:-0}"

# Rotate the argument list, dropping the flags this wrapper owns. The shift/append idiom is used
# rather than string concatenation so arguments containing spaces survive intact.
argc=$#
i=0
while [ "$i" -lt "$argc" ]; do
  arg="$1"
  shift
  case "$arg" in
    --tailscale) tailscale_enabled=1 ;;
    --no-tailscale) tailscale_enabled=0 ;;
    *) set -- "$@" "$arg" ;;
  esac
  i=$((i + 1))
done

# FNXC:DockerRun 2026-08-31-14:24:
# Liveness is decided by an actual RUNNING PROCESS, never by the socket FILE. `docker restart` reuses
# the container's writable layer, so /var/run/tailscale/tailscaled.sock survives a stop with no
# daemon behind it; a `[ ! -S ... ]` guard then reads that corpse as "already running", skips startup,
# and the box comes back with remote access silently dead — the dashboard healthy, `tailscale` itself
# answering `connect: connection refused`. Measured on a live restart. The stale file is removed
# before starting, because tailscaled will not bind over it.
tailscaled_running() {
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    case "$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null)" in
      *tailscaled*) return 0 ;;
    esac
  done
  return 1
}

if [ "$tailscale_enabled" = "1" ] && [ -x /usr/sbin/tailscaled ]; then
  if ! tailscaled_running; then
    rm -f /var/run/tailscale/tailscaled.sock
    /usr/sbin/tailscaled \
      --tun=userspace-networking \
      --socks5-server=localhost:1055 \
      --outbound-http-proxy-listen=localhost:1055 \
      >/var/log/tailscaled.log 2>&1 &
  fi
fi

exec node /app/packages/cli/dist/bin.js "$@"
