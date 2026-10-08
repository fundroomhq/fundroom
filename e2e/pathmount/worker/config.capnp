# workerd config for worker.test (harness). On Cloudflare the equivalent is a route
# `www.acme.com/*` bound to `seed-host-mount.js`; nothing here is part of the recipe.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .site),
    # Outbound fetches. `private` because portal.test is a Compose address; the edge's internal
    # CA is the only root trusted, so the hop to the portal is verified TLS.
    (name = "internet", network = (
      allow = ["public", "private"],
      tlsOptions = (trustedCertificates = [embed "edge-root.crt"]),
    )),
  ],
  sockets = [(name = "http", address = "*:8787", http = (), service = "main")],
);

const site :Workerd.Worker = (
  modules = [
    (name = "harness.js", esModule = embed "harness.js"),
    (name = "seed-host-mount.js", esModule = embed "seed-host-mount.js"),
  ],
  compatibilityDate = "2026-09-01",
  globalOutbound = "internet",
);
