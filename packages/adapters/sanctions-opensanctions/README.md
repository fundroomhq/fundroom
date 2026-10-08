# @fundroom/sanctions-opensanctions

`SanctionsScreeningPort` over [OpenSanctions](https://www.opensanctions.org): a
self-hosted [yente](https://yente.followthemoney.tech/) server or the hosted matching API. Operations:
[`docs/runbooks/sanctions.md`](../../../docs/runbooks/sanctions.md).

Exports `createOpenSanctionsScreening(deps, options?)` and `OPENSANCTIONS_DATASET` (`sanctions`).

- `screen` → one `POST /match/sanctions` for a `Company` with `name` and `country`. A result counts when its
  score is at or above the configured threshold (yente's own `match` flag is ignored). `programs` are the
  result's datasets.
- `listVersion` → `opensanctions:sanctions:<catalogue version>`, cached 10 minutes for screens.
- Timeout 15 s, 2 MiB, no redirects. yente has **no authentication**: keep it on a private network (the
  configured host is exempt from the private-address check). The API key is sent as
  `Authorization: ApiKey …` only over https and only to `api.opensanctions.org` or a host in
  `SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS`.
- A name with no letters or digits is refused (`unscreenable`); other scripts go to the service as they are.
- `meta.subProcessor` is set only for the hosted API (`api.opensanctions.org`), which sees each screened
  company's name and country.

**Licence.** OpenSanctions data is CC BY-NC 4.0. Screening customers as a business needs a commercial data
licence, for yente and the hosted API alike. This package is MIT like the rest of the code, but the data is
not.
