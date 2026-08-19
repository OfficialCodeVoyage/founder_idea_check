# ─────────────────────────────────────────────────────────────────────────────
# PYTHON 3.11, AND THE REASON IS OASIS. DO NOT BUMP THIS CASUALLY.
#
# `camel-ai/oasis` @ 40bf1705 declares, in its own pyproject.toml line 25:
#
#     python = ">=3.10.0,<3.12"
#
# That is a hard upper bound on 3.12, not a preference, and it is the binding
# constraint on this entire image. Everything else here runs on 3.13 happily.
# 3.11 is chosen over 3.10 because it is the newest version inside OASIS's
# window, so the pin buys the most runtime and stdlib improvement available
# without leaving the range.
#
# Changing this later is expensive: OASIS's dependency table is exact-pinned
# (camel-ai==0.2.90, sentence-transformers==3.0.0, igraph==0.11.6) with no
# extras mechanism, so a Python bump means resolving that whole tree again.
#
# NOTE ON THE GRAPH BACKEND: OASIS uses the **igraph in-memory** backend by
# default (`oasis/social_agent/agent_graph.py:178-190` — neo4j requires an
# explicit `backend="neo4j"` plus a valid Neo4jConfig, and the documented
# generators pass neither). So there is NO graph database in this image and
# none in docker-compose.yml. Do not add one.
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS base

# `import oasis` opens log files relative to the CURRENT DIRECTORY at import
# time (`oasis/environment/env.py:30-32`, `social_platform/platform.py:37-39`,
# `social_agent/agent.py:44-45`). An unwritable CWD makes the import itself
# fail, so the workdir must be writable by the runtime user.
WORKDIR /srv/research

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY pyproject.toml README.md ./
COPY app ./app

# The DEFAULT image installs the signal half only. The `simulation` extra is
# NOT installed here on purpose: it pulls camel-ai, which pulls torch and
# sentence-transformers, which is multiple gigabytes and a CUDA probe at import
# time (`oasis/social_platform/recsys.py:26-29`, `:46`).
#
# Most deployments want demand signals and never run a simulation. Bundling the
# ML stack would make every signal request wait on a cold start it does not
# need, and would let a torch import failure take down the endpoints the phase
# gate actually depends on.
#
# To build an image WITH simulation, use the `simulation` stage below.
RUN pip install --no-cache-dir .

# Non-root, and it owns the workdir because of the log-file behaviour above.
RUN useradd --create-home --uid 10001 research \
    && chown -R research:research /srv/research
USER research

EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/v1/health', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8099"]


# ─────────────────────────────────────────────────────────────────────────────
# OPT-IN STAGE for Step 8. Build with:
#   docker build --target simulation -t idea-check-research:sim apps/research
#
# Expect a multi-gigabyte image and a slow first import. That cost is the whole
# reason this is a separate stage rather than a line in the default one.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS simulation
USER root
RUN pip install --no-cache-dir ".[simulation]"
USER research
