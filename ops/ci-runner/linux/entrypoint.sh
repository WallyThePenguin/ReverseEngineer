#!/usr/bin/env bash
# Starts Hearth's Linux CI runner. The first start registers it with GitHub, from the environment:
#   RUNNER_TOKEN  a registration token (an hour's use; linux-runner.ps1 passes it, never shown)
#   RUNNER_URL    https://github.com/WallyThePenguin/ReverseEngineer
#   RUNNER_NAME   hearth-pc-linux
# The registration is kept in /home/runner/config (a named volume), so later starts, and new
# containers from a rebuilt image, run straight away without a token.
set -euo pipefail
cd /home/runner

CONFIG=/home/runner/config
# Not .env and .path: without them the runner takes its environment and PATH from the image, so
# a rebuilt image's PATH isn't masked by the first container's.
FILES=(.runner .credentials .credentials_rsaparams)

# The runner looks for its registration next to itself: link it in from the volume.
link_config() {
  for f in "${FILES[@]}"; do
    if [ -e "$CONFIG/$f" ]; then ln -sfn "$CONFIG/$f" "/home/runner/$f"; fi
  done
}

if [ -f "$CONFIG/.runner" ]; then
  link_config
else
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    echo "Not registered yet, and no RUNNER_TOKEN: start it with ops/ci-runner/linux-runner.ps1 -Start." >&2
    exit 1
  fi
  ./config.sh --unattended --replace \
    --url "${RUNNER_URL:-https://github.com/WallyThePenguin/ReverseEngineer}" \
    --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-hearth-pc-linux}" \
    --labels hearth-ci \
    --work /home/runner/_work
  for f in "${FILES[@]}"; do
    if [ -e "/home/runner/$f" ] && [ ! -L "/home/runner/$f" ]; then mv "/home/runner/$f" "$CONFIG/$f"; fi
  done
  link_config
  echo "Registered as ${RUNNER_NAME:-hearth-pc-linux}."
fi

# The token has done its job: jobs never see it.
unset RUNNER_TOKEN
exec env -u RUNNER_TOKEN ./run.sh
