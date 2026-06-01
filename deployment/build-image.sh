#!/usr/bin/env bash
#
# Build the svg-validator Docker image from ../Dockerfile and (optionally) push
# it to Docker Hub. This is the build/push half of deploy.sh, with no kubectl —
# use it when you just want an image on Docker Hub.
#
# Usage:
#   ./build-image.sh             # build ${IMAGE_REPO}:<VERSION> and :latest
#   ./build-image.sh --push      # build, then docker push both tags
#
# Version is read from ../VERSION. To push you must already be logged in
# (`docker login`) as a user that can push to ${IMAGE_REPO}.

set -euo pipefail

IMAGE_REPO="pointr/vusion-svg-validator"
PLATFORM="linux/amd64"

GREEN="\033[32m"
YELLOW="\033[33m"
RESET="\033[0m"

PUSH="false"
if [[ "${1:-}" == "--push" ]]; then
  PUSH="true"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="$(tr -d '[:space:]' < "${APP_DIR}/VERSION")"
IMAGE="${IMAGE_REPO}:${VERSION}"

echo -e "${GREEN}Building ${IMAGE} for ${PLATFORM}...${RESET}"
# --pull refreshes the base image; --no-cache forces every COPY layer to
# rebuild so local edits always ship. Build context is the tool root so the
# Dockerfile's COPY paths resolve.
docker build --pull --no-cache --platform="${PLATFORM}" \
  -t "${IMAGE}" \
  -f "${APP_DIR}/Dockerfile" "${APP_DIR}"

echo -e "${GREEN}Built ${IMAGE}${RESET}"

if [[ "${PUSH}" == "true" ]]; then
  echo -e "${GREEN}Pushing ${IMAGE}...${RESET}"
  docker push "${IMAGE}"
  echo -e "${GREEN}Pushed.${RESET}"
else
  echo -e "${YELLOW}Image built locally. Push with:${RESET}"
  echo "    docker push ${IMAGE}"
  echo -e "${YELLOW}Or re-run: ./build-image.sh --push${RESET}"
fi
