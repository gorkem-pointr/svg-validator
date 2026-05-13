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

CURRENT_CONTEXT="$(kubectl config current-context)"
if [[ "${CURRENT_CONTEXT}" != "${EXPECTED_CONTEXT}" ]]; then
  echo "Refusing to deploy: kubectl context is '${CURRENT_CONTEXT}', expected '${EXPECTED_CONTEXT}'." >&2
  echo "Switch with: kubectl config use-context ${EXPECTED_CONTEXT}" >&2
  exit 1
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

GREEN="\033[32m"
RESET="\033[0m"

echo -e "${GREEN}Building ${IMAGE} for linux/amd64...${RESET}"
docker build --platform=linux/amd64 -t "${IMAGE}" "${APP_DIR}"

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
