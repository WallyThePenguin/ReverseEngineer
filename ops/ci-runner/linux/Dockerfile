# Hearth's Linux CI runner (D66, docs/ci.md): GitHub's own runner image, plus what the "check"
# job needs that GitHub's Ubuntu runners have and this image doesn't. It runs on the owner's PC in
# Docker Desktop, one job at a time, with no published ports, no Docker socket and none of the
# PC's drives: ops/ci-runner/linux-runner.ps1 starts it.
#
# The base (actions/runner's images/Dockerfile at v2.337.0): Ubuntu 24.04, the runner in
# /home/runner, user runner (uid 1001) with passwordless sudo inside the container, curl, git, jq,
# unzip, and a Docker client with no daemon to talk to. Bump the tag here when GitHub retires a
# runner version; the runner also updates itself in the container until the image is rebuilt.
FROM ghcr.io/actions/actions-runner:2.337.0

ARG PG_MAJOR=16

USER root

# PostgreSQL 16 server and client from PGDG (the major is the package name). The job starts its
# own cluster in RUNNER_TEMP, so the package's default cluster isn't made.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common \
    && sed -ri 's/^#?\s*create_main_cluster\s*=.*/create_main_cluster = false/' \
        /etc/postgresql-common/createcluster.conf \
    && apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" \
    && rm -rf /var/lib/apt/lists/*
# The job's pg_ctl, psql, pg_dump and pg_restore, ahead of Debian's version-picking wrappers.
ENV PATH="/usr/lib/postgresql/${PG_MAJOR}/bin:${PATH}"

# What `playwright install --with-deps chromium` adds on Ubuntu 24.04 (Playwright 1.63's list):
# Chromium's libraries, and the fonts and Xvfb it installs alongside. Plus git, procps (pkill)
# and xz-utils (Node's archives).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git procps xz-utils \
        libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 \
        libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 \
        libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
        libxkbcommon0 libxrandr2 \
        xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 \
        xfonts-cyrillic xfonts-scalable fonts-liberation fonts-ipafont-gothic \
        fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# The runner's registration lives in config/ and jobs in _work/, each a named volume: a new
# container from a new image picks up both. Made here so the volumes start out the runner's.
RUN mkdir -p /home/runner/config /home/runner/_work \
    && chown runner:runner /home/runner/config /home/runner/_work
COPY --chown=runner:runner --chmod=755 entrypoint.sh /home/runner/entrypoint.sh

USER runner
WORKDIR /home/runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
