#!/usr/bin/env bash
#
# Force the cluster to re-pull the current image tag without rebuilding.
# Useful when the image at the same VERSION tag was updated out-of-band
# (e.g. pushed from CI) and you want pods to pick it up.
#
# Usage:
#   ./rollout.sh

set -euo pipefail

NAMESPACE="svg-validator"
EXPECTED_CONTEXT="pointr-algorithms-cluster"

CURRENT_CONTEXT="$(kubectl config current-context)"
if [[ "${CURRENT_CONTEXT}" != "${EXPECTED_CONTEXT}" ]]; then
  echo "Refusing to roll out: kubectl context is '${CURRENT_CONTEXT}', expected '${EXPECTED_CONTEXT}'." >&2
  echo "Switch with: kubectl config use-context ${EXPECTED_CONTEXT}" >&2
  exit 1
fi

GREEN="\033[32m"
RESET="\033[0m"

echo -e "${GREEN}Restarting deployment to pull image...${RESET}"
kubectl -n "${NAMESPACE}" rollout restart deploy/svg-validator

echo -e "${GREEN}Waiting for rollout...${RESET}"
kubectl -n "${NAMESPACE}" rollout status deploy/svg-validator

echo -e "${GREEN}Done. Serving at https://algorithms.pointr.cloud/svg-validator/${RESET}"
