#!/usr/bin/env bash
#
# Build, push, and deploy the svg-validator static site to the
# pointr-algorithms AKS cluster behind https://algorithms.pointr.cloud/svg-validator
#
# Usage:
#   ./deploy.sh
#
# Version is read from ../VERSION. Docker registry credentials for pulling
# the private image are read from ./.env (see .env.example).
#
# Requirements (one-time, not managed by this script):
#   - docker logged into Docker Hub as a user that can push to ${IMAGE_REPO}
#   - kubectl context pointing at the pointr-algorithms-cluster, e.g.
#       az aks get-credentials \
#         -g pointr-algorithms-resource-group \
#         -n pointr-algorithms-cluster
#   - nginx-ingress controller and DNS for algorithms.pointr.cloud already
#     exist on the cluster (shared platform infra)

set -euo pipefail

NAMESPACE="svg-validator"
IMAGE_REPO="pointr/vusion-svg-validator"
EXPECTED_CONTEXT="pointr-algorithms-cluster"

YELLOW="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

CURRENT_CONTEXT="$(kubectl config current-context)"
SWITCHED_CONTEXT="false"
if [[ "${CURRENT_CONTEXT}" != "${EXPECTED_CONTEXT}" ]]; then
  echo -e "${YELLOW}kubectl context is '${CURRENT_CONTEXT}', switching to '${EXPECTED_CONTEXT}' for this deploy.${RESET}"
  if ! kubectl config use-context "${EXPECTED_CONTEXT}" >/dev/null 2>&1; then
    echo -e "${RED}Failed to switch context to '${EXPECTED_CONTEXT}'. Is it in your kubeconfig?${RESET}" >&2
    echo -e "${RED}Fetch credentials with: az aks get-credentials -g pointr-algorithms-resource-group -n ${EXPECTED_CONTEXT}${RESET}" >&2
    exit 1
  fi
  SWITCHED_CONTEXT="true"
  # Restore the user's previous context on exit (success or failure) so the
  # terminal doesn't silently end up pointing at a different cluster.
  trap 'echo -e "${YELLOW}Restoring kubectl context to ${CURRENT_CONTEXT}.${RESET}"; kubectl config use-context "${CURRENT_CONTEXT}" >/dev/null 2>&1 || true' EXIT
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="$(tr -d '[:space:]' < "${APP_DIR}/VERSION")"
IMAGE="${IMAGE_REPO}:${VERSION}"

if [[ ! -f "${SCRIPT_DIR}/.env" ]]; then
  echo "Missing ${SCRIPT_DIR}/.env — copy .env.example and fill in credentials." >&2
  exit 1
fi
set -o allexport
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/.env"
set +o allexport

echo -e "${GREEN}Building ${IMAGE} for linux/amd64...${RESET}"
# --pull refreshes the base image; --no-cache forces every layer (incl. COPYs)
# to rebuild from source. Tiny image, so the few extra seconds are worth the
# guarantee that local edits actually ship.
docker build --pull --no-cache --platform=linux/amd64 -t "${IMAGE}" "${APP_DIR}"

echo -e "${GREEN}Pushing ${IMAGE}...${RESET}"
docker push "${IMAGE}"

echo -e "${GREEN}Ensuring namespace ${NAMESPACE}...${RESET}"
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

echo -e "${GREEN}Ensuring image pull secret...${RESET}"
kubectl -n "${NAMESPACE}" create secret docker-registry regcred \
  --docker-server="${DOCKER_REGISTRY_SERVER}" \
  --docker-username="${DOCKER_USERNAME}" \
  --docker-password="${DOCKER_PASSWORD}" \
  --docker-email="${DOCKER_EMAIL}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo -e "${GREEN}Applying manifests...${RESET}"
kubectl apply -f "${SCRIPT_DIR}/service.yaml"
kubectl apply -f "${SCRIPT_DIR}/ingress.yaml"
IMAGE="${IMAGE}" envsubst < "${SCRIPT_DIR}/deployment.yaml" | kubectl apply -f -

echo -e "${GREEN}Waiting for rollout...${RESET}"
kubectl -n "${NAMESPACE}" rollout status deploy/svg-validator

echo -e "${GREEN}Done. Serving at https://algorithms.pointr.cloud/svg-validator/${RESET}"
