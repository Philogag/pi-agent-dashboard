# =============================================================================
#  pi-agent-dashboard — self-contained image built DIRECTLY from this repo
#
#  Unlike the upstream oh-pi-dashboard (which codeload-fetches the dashboard
#  source at a DASHBOARD_REF), this Dockerfile builds from the LOCAL build
#  context — i.e. whatever is checked out in THIS repository at build time.
#  That guarantees fork-local changes to packages/ (including the relocated
#  pi-matrix-bridge-plugin, whose settings-section client UI only ships when
#  it lives inside this monorepo's source tree) are baked into the image.
#
#  Build it from the repo root:
#      docker build -t pi-agent-dashboard . --build-arg MIRROR_CN=0
#
#  Multi-stage layout:
#    node-base           — debian + node + basic tools (shared by all stages)
#    dashboard-builder   — COPY this repo's source, pnpm install, build the
#                          web client, npm pack the workspace tarballs
#    runtime             — final image: pi/openspec from npm registry +
#                          dashboard tarballs from the builder stage
#
#  The pi/pi-ai versions are NOT hardcoded — the builder reads the pi-coding-
#  agent version locked in this repo's pnpm lockfile and the runtime installs
#  it (plus pi-ai global) so the server graph + model-proxy stay in lockstep
#  with the dashboard.
# =============================================================================

# ============================== Stage: node-base ==============================
FROM debian:bookworm-slim AS node-base

ARG ARCH=amd64
ARG NODE_VERSION=v24.19.0
ARG MIRROR_CN=1

ENV NODE_HOME=/opt/node
ENV TZ=Asia/Shanghai

# install basic tools
RUN if [ "${MIRROR_CN}" = "1" ]; then \
      sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl wget gzip \
    git \
    ripgrep \
    findutils \
    gosu \
    jq \
    vim \
    openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd || true \
  && apt-get clean

# install nodejs via nvm
RUN cat <<EOF >> /opt/install_node.sh
NODE_VERSION=\$1
ARCH=\$2
MIRROR_CN=\$3
case \${MIRROR_CN} in
  1)
    MIRROR_HOST=https://mirror.nju.edu.cn/nodejs-release
    ;;
  *)
    MIRROR_HOST=https://nodejs.org/dist
    ;;
esac
case \$ARCH in
  arm64)
    RELEASE_TYPE=linux-arm64
    ;;
  *)
    RELEASE_TYPE=linux-x64
    ;;
esac
NODE_NAME=node-\${NODE_VERSION}-\${RELEASE_TYPE}
wget \${MIRROR_HOST}/\${NODE_VERSION}/\${NODE_NAME}.tar.gz
mkdir -p /opt/node
tar -xf \${NODE_NAME}.tar.gz -C /opt/node
rm \${NODE_NAME}.tar.gz
ln -s /opt/node/\${NODE_NAME} /opt/node/latest 
EOF
RUN bash /opt/install_node.sh ${NODE_VERSION} ${ARCH} ${MIRROR_CN}
ENV PATH="/opt/node/latest/bin:${PATH}"

# Grant pi the node runtime via a BUILD-TIME supplementary group instead of a
# runtime `chown -R /opt/node` on every container start (slow on the whole
# nvm tree). Group `node` gets service-range GID 999 — below the user range —
# so it can never collide with the PUID/PGID the entrypoint remaps to
# (entrypoint enforces >= 1000, and build-time `groupadd -g $PUID pi` uses
# 1000). Group owns /opt/node, group-writable with exec kept (g+rwX); pi
# joins at user creation; supplementary memberships survive the entrypoint's
# usermod/groupmod remap, so a remapped PUID writes through the group
# regardless of ownership.
RUN groupadd -g 999 node \
 && chown -R root:node /opt/node \
 && chmod -R g+rwX /opt/node

# ======================== Stage: dashboard-builder ============================
FROM node-base AS dashboard-builder

ARG MIRROR_CN=1

# keep the vite prod build inside a bounded heap instead of letting it balloon
# to the whole container memory (the full monorepo web build is heavy)
ENV NODE_OPTIONS=--max-old-space-size=4096

# npm registry mirror for CN (pnpm reads the same .npmrc)
RUN if [ "${MIRROR_CN}" = "1" ]; then \
      npm config --global set registry https://registry.npmmirror.com/; \
    fi

# pnpm version must match the repo's packageManager field (pnpm@11.15.1)
RUN npm install -g pnpm@11.15.1

# python/make/g++ are insurance for deps that compile native modules
# (e.g. node-pty) during `pnpm install`; builder stage only, not shipped
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

# build THIS repo's checked-out source. .dockerignore prunes .git / node_modules
# / dist before transfer so the context stays small. The web client build
# (packages/client, via the workspace build script) embeds every plugin under
# packages/ with a `pi-dashboard-plugin` manifest — including the relocated
# pi-matrix-bridge-plugin — into the immutable production bundle.
COPY . /src/dashboard
WORKDIR /src/dashboard

RUN pnpm install \
 && pnpm run build

# pack the npm tarballs the server graph needs at runtime: the workspace
# packages the server depends on (client = @blackbelt-technology/pi-dashboard-web)
# plus the kb series (core lib, isolated agent extension, dashboard plugin) and
# the relocated pi-matrix-bridge-plugin (so the server can load it as an
# external plugin from ~/.pi/dashboard/plugins).
# Deliberately NOT packing the root meta package (pi-agent-dashboard): it also
# ships a `pi-dashboard` bin and, in a multi-tarball global install, wins the
# /bin symlink; from its nested location `jiti` is not a resolvable dep, which
# breaks the server wrapper ("cannot find jiti"). The server package's own bin
# resolves jiti correctly, so we let it own the bin.
# NOTE: `./packages/...` — without the `./` npm treats the path as a
# GitHub shorthand spec (user/repo) and tries `git ls-remote` on it.
RUN mkdir -p /out \
  && for p in server client shared extension dashboard-plugin-runtime document-converter \
             kb kb-extension kb-plugin pi-matrix-bridge-plugin; do \
       npm pack ./packages/$p --ignore-scripts --pack-destination /out || exit 1; \
     done \
  && ls -la /out

# Pin the pi (pi-coding-agent) version to the exact one the dashboard graph
# resolved -- read from the installed top-level package (hoisted symlink into
# .pnpm), never from a hardcoded ARG that drifts from the repo's pnpm lockfile
# (which overrides pi-coding-agent to a specific version). The server's
# model-proxy resolves pi-ai from the top-level global node_modules via
# createRequire, so pi-ai must also be installed global; pi and pi-ai are
# version-lockstepped in the pi repo, so both use this same version.
RUN jq -r .version node_modules/@earendil-works/pi-coding-agent/package.json > /out/pi-version \
 && echo "[builder] locked pi version: $(cat /out/pi-version)"
# ================================ Stage: runtime ==============================
FROM node-base AS runtime

# Optional override; when empty, the runtime falls back to the pi version the
# dashboard-builder pinned into /pi-version (read from its own pnpm lockfile).
ARG PI_VERSION=
ARG MIRROR_CN=1

ENV PUID=1000
ENV PGID=1000
ENV PI_DASHBOARD_HOST=0.0.0.0
ENV PI_GATEWAY_BIND=0.0.0.0

# npm registry mirror for CN
RUN if [ "${MIRROR_CN}" = "1" ]; then \
      npm config --global set registry https://registry.npmmirror.com/; \
    fi

# copy the pi version pinned by the builder so the runtime installs the same
# pi the server graph was resolved against
COPY --from=dashboard-builder /out/pi-version /pi-version

# install pi and openspec from the npm registry (typebox satisfies the
# optional peer of the kb extension so its src loads without a resolution miss)
# pi-ai is installed global too: the server's model-proxy resolves it from the
# top-level global node_modules, and pi/pi-ai are version-lockstepped.
RUN PIV="${PI_VERSION:-$(cat /pi-version)}" \
 && [ -n "$PIV" ] || { echo "[runtime] no pi version from ARG or builder pin"; exit 1; } \
 && echo "[runtime] installing pi/pi-ai @ $PIV" \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PIV" \
 && npm install -g "@earendil-works/pi-ai@$PIV" \
 && npm install -g @fission-ai/openspec \
 && npm install -g typebox@1 \
 && npm cache clean --force

# install the built dashboard tarballs (single npm pass so the
# ^0.7.0 workspace dependencies resolve against the local tarballs instead
# of the published registry versions; scripts run so the pty/permissions
# postinstall fixes apply)
COPY --from=dashboard-builder /out/*.tgz /tmp/dashboard/
RUN npm install -g /tmp/dashboard/*.tgz \
 && rm -rf /tmp/dashboard \
 && npm cache clean --force

# Shared playwright browser cache: pre-baked for pi and writable at runtime
# so pi can run `playwright install` on demand (same build-time node group as
# /opt/node: root:node + g+rwX, no runtime chown).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Pre-install playwright + chromium (+ its apt deps; --with-deps runs its own
# apt-get update so the base image lists are fine). Firefox/webkit NOT baked.
# MIRROR_CN=1: browser binaries come from the npmmirror CDN (the azure edge
# CDN is slow from CN); the same host is exported at runtime via
# /etc/environment so pi's own browser installs reuse the mirror.
RUN if [ "${MIRROR_CN}" = "1" ]; then \
      echo 'PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright' >> /etc/environment; \
      export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright; \
    fi \
 && npm install -g playwright \
 && npx playwright install --with-deps chromium \
 && chown -R root:node /ms-playwright \
 && chmod -R g+rwX /ms-playwright \
 && npm cache clean --force

RUN  groupadd -g $PUID pi \
  && useradd -m -u $PGID -g pi -s /bin/bash pi \
  && usermod -aG node pi

RUN cat <<EOF >> /entrypoint.sh
if [[ -z "\${PUID}" || -z "\${PGID}" ]] || ! [[ "\${PUID}" =~ ^[0-9]+$ ]] || ! [[ "\${PGID}" =~ ^[0-9]+$ ]]; then
  echo "[supervisor][error] Invalid PUID/PGID = \${PUID}/\${PGID} (must be numeric)"
  exit -1
fi
if [[ \${PUID} -lt 1000 || \${PGID} -lt 1000 ]]; then
  echo "[supervisor][error] Invalid PUID/PGID = \${PUID}/\${PGID} (must be >= 1000 — below that collides with the service-range node group GID 999)"
  exit -1
fi

echo "[supervisor][info] Target UID=\${PUID}, GID=\${PGID}"
CURRENT_UID=\$(id -u pi)
CURRENT_GID=\$(id -g pi)
if [ "\${CURRENT_GID}" != "\${PGID}" ]; then
  groupmod -g "\${PGID}" pi 2>/dev/null || true
fi
if [ "\${CURRENT_UID}" != "\${PUID}" ]; then
  usermod -u "\${PUID}" -g "\${PGID}" pi 2>/dev/null || true
fi

echo "[supervisor][info] Solve pi home ownership"
chown "\${PUID}:\${PGID}" /home/pi/.pi 2>/dev/null || true
chown "\${PUID}:\${PGID}" /home/pi 2>/dev/null || true

echo "[supervisor][info] Solve workspace ownership"
chown "\${PUID}:\${PGID}" /workspace 2>/dev/null || true

echo "[supervisor][info] Node runtime + playwright cache writable to pi via node group (baked at build)"

echo "[supervisor][info] Inject pi-dashboard configs"
CFG_HOME=/home/pi/.pi/dashboard
CFG_FILE=\${CFG_HOME}/config.json
if [[ ! -d \${CFG_HOME} ]]; then
  mkdir -p \${CFG_HOME}
fi
if [[ ! -s \${CFG_FILE} ]]; then
  echo "{}" > \${CFG_FILE}
fi
function set_str {
  path=\$1
  val=\$2
  if [[ ! -z "\$val" ]]; then
    cat \${CFG_FILE} | jq "\${path} = \"\${val}\"" > \${CFG_FILE}.tmp
    mv \${CFG_FILE}.tmp \${CFG_FILE}
  fi
}
set_str ".trustedNetworks[0]"                   "\$PI_DASHBOARD_TRUSTNETWORK"
set_str ".auth.redirectBaseUrl"                 "\$PI_DASHBOARD_BASEURL"
set_str ".auth.secret"                          "\$PI_DASHBOARD_AUTH_SECRET"
set_str ".auth.providers.github.clientId"       "\$PI_DASHBOARD_GITHUB_CLIENT_ID"
set_str ".auth.providers.github.clientSecret"   "\$PI_DASHBOARD_GITHUB_CLIENT_SECRET"
set_str ".auth.providers.google.clientId"       "\$PI_DASHBOARD_GOOGLE_CLIENT_ID"
set_str ".auth.providers.google.clientSecret"   "\$PI_DASHBOARD_GOOGLE_CLIENT_SECRET"
set_str ".auth.providers.keycloak.clientId"     "\$PI_DASHBOARD_KEYCLOAK_CLIENT_ID"
set_str ".auth.providers.keycloak.clientSecret" "\$PI_DASHBOARD_KEYCLOAK_CLIENT_SECRET"
set_str ".auth.providers.keycloak.issuerUrl"    "\$PI_DASHBOARD_KEYCLOAK_CLIENT_ISSUER"
set_str ".auth.providers.oidc.clientId"         "\$PI_DASHBOARD_OIDC_CLIENT_ID"
set_str ".auth.providers.oidc.clientSecret"     "\$PI_DASHBOARD_OIDC_CLIENT_SECRET"
set_str ".auth.providers.oidc.issuerUrl"        "\$PI_DASHBOARD_OIDC_CLIENT_ISSUER"
cat \${CFG_FILE}
chown "\${PUID}:\${PGID}" \${CFG_HOME} 2>/dev/null || true
chown "\${PUID}:\${PGID}" \${CFG_FILE} 2>/dev/null || true

echo "[supervisor][info] Link kb plugin for dashboard plugin discovery"
KB_PLUGIN_DIR=/home/pi/.pi/dashboard/plugins
KB_PLUGIN_SRC=/opt/node/latest/lib/node_modules/@blackbelt-technology/pi-dashboard-kb-plugin
mkdir -p \${KB_PLUGIN_DIR}
if [ -d "\${KB_PLUGIN_SRC}" ]; then
  rm -rf \${KB_PLUGIN_DIR}/kb-plugin
  mkdir -p \${KB_PLUGIN_DIR}/kb-plugin
  # keep the manifest (pi-dashboard-plugin) so the loader discovers it
  cp \${KB_PLUGIN_SRC}/package.json \${KB_PLUGIN_DIR}/kb-plugin/package.json
  # client/server entries resolve to the real source files
  ln -s \${KB_PLUGIN_SRC}/src \${KB_PLUGIN_DIR}/kb-plugin/src
  # expose a node_modules view so the plugin's own imports resolve even though
  # the entry lives outside the global node_modules tree — a plain package
  # symlink alone breaks the module namespace ("Cannot find module ...")
  ln -s /opt/node/latest/lib/node_modules \${KB_PLUGIN_DIR}/kb-plugin/node_modules
fi

echo "[supervisor][info] Link pi-matrix-bridge plugin for dashboard plugin discovery"
MB_PLUGIN_SRC=/opt/node/latest/lib/node_modules/@blackbelt-technology/pi-matrix-bridge-plugin
if [ -d "\${MB_PLUGIN_SRC}" ]; then
  rm -rf \${KB_PLUGIN_DIR}/pi-matrix-bridge-plugin
  mkdir -p \${KB_PLUGIN_DIR}/pi-matrix-bridge-plugin
  cp \${MB_PLUGIN_SRC}/package.json \${KB_PLUGIN_DIR}/pi-matrix-bridge-plugin/package.json
  ln -s \${MB_PLUGIN_SRC}/src \${KB_PLUGIN_DIR}/pi-matrix-bridge-plugin/src
  ln -s /opt/node/latest/lib/node_modules \${KB_PLUGIN_DIR}/pi-matrix-bridge-plugin/node_modules
fi
chown -R "\${PUID}:\${PGID}" \${KB_PLUGIN_DIR} 2>/dev/null || true

echo "[supervisor][info] Register kb extension in pi settings"
PI_SETTINGS=/home/pi/.pi/agent/settings.json
mkdir -p /home/pi/.pi/agent
if [ ! -f "\${PI_SETTINGS}" ]; then
  echo "{}" > "\${PI_SETTINGS}"
fi
KB_EXT_SRC=/opt/node/latest/lib/node_modules/@blackbelt-technology/pi-dashboard-kb-extension
if [ -d "\${KB_EXT_SRC}" ]; then
  if ! jq -e --arg p "\${KB_EXT_SRC}" '(.packages // []) | index(\$p)' "\${PI_SETTINGS}" >/dev/null 2>&1; then
    jq --arg p "\${KB_EXT_SRC}" '.packages = ((.packages // []) + [\$p])' "\${PI_SETTINGS}" > "\${PI_SETTINGS}.tmp" \
      && mv "\${PI_SETTINGS}.tmp" "\${PI_SETTINGS}"
  fi
fi
chown -R "\${PUID}:\${PGID}" /home/pi/.pi/agent 2>/dev/null || true

echo "[supervisor][info] Enter runtime"
# Surface /etc/environment (e.g. PLAYWRIGHT_DOWNLOAD_HOST) to the dropped-down
# user — `exec gosu pi` bypasses PAM, which would otherwise read it.
set -a; [ -f /etc/environment ] && . /etc/environment; set +a
exec gosu pi "\$@"
EOF
RUN chmod +x /entrypoint.sh

VOLUME  /home/pi/.pi
VOLUME  /workspace
WORKDIR /workspace

EXPOSE 8000

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
CMD ["pi-dashboard"]
