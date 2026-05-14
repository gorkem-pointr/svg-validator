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

YELLOW="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

CURRENT_CONTEXT="$(kubectl config current-context)"
if [[ "${CURRENT_CONTEXT}" != "${EXPECTED_CONTEXT}" ]]; then
  echo -e "${YELLOW}kubectl context is '${CURRENT_CONTEXT}', switching to '${EXPECTED_CONTEXT}' for this rollout.${RESET}"
  if ! kubectl config use-context "${EXPECTED_CONTEXT}" >/dev/null 2>&1; then
    echo -e "${RED}Failed to switch context to '${EXPECTED_CONTEXT}'. Is it in your kubeconfig?${RESET}" >&2
    echo -e "${RED}Fetch credentials with: az aks get-credentials -g pointr-algorithms-resource-group -n ${EXPECTED_CONTEXT}${RESET}" >&2
    exit 1
  fi
  # Restore the user's previous context on exit (success or failure) so the
  # terminal doesn't silently end up pointing at a different cluster.
  trap 'echo -e "${YELLOW}Restoring kubectl context to ${CURRENT_CONTEXT}.${RESET}"; kubectl config use-context "${CURRENT_CONTEXT}" >/dev/null 2>&1 || true' EXIT
fi

echo -e "${GREEN}Restarting deployment to pull image...${RESET}"
kubectl -n "${NAMESPACE}" rollout restart deploy/svg-validator

echo -e "${GREEN}Waiting for rollout...${RESET}"
kubectl -n "${NAMESPACE}" rollout status deploy/svg-validator

echo -e "${GREEN}Done. Serving at https://algorithms.pointr.cloud/svg-validator/${RESET}"
