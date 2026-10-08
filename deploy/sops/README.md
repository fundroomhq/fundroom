# Encrypted env files with SOPS + age

For operators who keep their production `.env` in Git: [SOPS](https://github.com/getsops/sops)
encrypts the **values** of a dotenv file to one or more [age](https://age-encryption.org) public
keys, leaving the variable names readable so diffs and reviews still make sense. FundRoom ships
no encrypted secrets; this directory is the recipe and an example `.sops.yaml`.

Conventions:

- Encrypted files are named `*.sops.env` (e.g. `prod.sops.env`). The repository's `.gitignore`
  ignores `.env` and `.env.*` but **not** `*.sops.env`, so they can be committed. Decrypted copies
  are never written into the repository (the workflow below does not create any).
- Only **public** age keys (`age1…`) go in `.sops.yaml`. A private key (`AGE-SECRET-KEY-1…`) never
  goes into a repository, a CI secret or a container image.
- CI never gets a decryption key. Nothing in this repository's workflows decrypts anything; a
  deploy host decrypts at deploy time with a key that lives only on that host (or on an operator's
  machine that runs the deploy).

The commands below were run with sops 3.x and age 1.x (`sops encrypt|decrypt|edit|exec-env|exec-file|updatekeys|rotate`).

## 1. Create keys

```sh
age-keygen -o ~/.config/sops/age/keys.txt        # prints "Public key: age1…"; keep the file private
# macOS: sops looks in ~/Library/Application Support/sops/age/keys.txt; or point SOPS_AGE_KEY_FILE
# at the file wherever it is.
```

Create at least two keys: one per operator (or deploy host) and an offline **recovery** key kept
with your backups. Losing every private key means losing the file's contents.

## 2. Configure recipients

Copy `.sops.yaml` from this directory to the root of the repository that will hold your encrypted
files (sops searches upwards from the working directory) and replace the placeholder with your
public keys, comma-separated:

```yaml
creation_rules:
  - path_regex: \.sops\.env$
    age: >-
      age1operator…,age1recovery…
```

The shipped placeholder is not a valid age key, so `sops` refuses to encrypt with an unedited copy
("failed to parse input as Bech32-encoded age public key").

## 3. Create and edit the encrypted file

```sh
sops edit deploy/sops/prod.sops.env      # opens $EDITOR on the plaintext; saves it encrypted
```

Put in it what you would put in `deploy/compose/.env` (see `deploy/compose/.env.example`):
`FUNDROOM_DOMAIN`, `POSTGRES_PASSWORD`, `FUNDROOM_SECRET_KEY`, `SMTP_URL`, … Each value is stored as
`ENC[AES256_GCM,data:…]`; the names stay in clear text.

To encrypt an existing plaintext file instead: write it as `prod.sops.env` outside the repository,
run `sops encrypt --in-place prod.sops.env`, then move it in.

## 4. Deploy with it (no plaintext on disk)

Compose reads interpolation variables from the shell environment before `.env`, so the simplest
route hands the decrypted values to Compose as environment variables of a single command:

```sh
cd deploy/compose
sops exec-env ../sops/prod.sops.env 'docker compose up -d'
```

If you prefer an env file, let sops write a temporary one and delete it afterwards:

```sh
sops exec-file --no-fifo ../sops/prod.sops.env 'docker compose --env-file {} up -d'
```

`--no-fifo` matters: with the default named pipe, `docker compose --env-file` blocks forever.
`sops decrypt ../sops/prod.sops.env` prints the plaintext if you need to look.

## 5. Rotate

- **Add or remove a person or host** — edit the recipients in `.sops.yaml`, then re-wrap the data
  key for the new list and generate a fresh data key so a removed key cannot read future edits:

  ```sh
  sops updatekeys --yes deploy/sops/prod.sops.env
  sops rotate --in-place deploy/sops/prod.sops.env
  ```

  Verified: after both commands, a removed recipient's key no longer decrypts the file. It can
  still decrypt the old versions in Git history — so when someone leaves, also rotate the secrets
  themselves (database password, SMTP credentials; for the master key see
  `docs/runbooks/rotate-keys.md`, which keeps the old key in `SECRET_KEY_RING`).
- **Change a secret** — `sops edit`, commit, redeploy.

## What not to do

- Do not add the age private key to GitHub Actions secrets "to validate the file in CI". A CI
  check can only prove the file is well-formed (`sops filestatus prod.sops.env` needs no key).
- Do not commit a decrypted copy. `.gitignore` ignores `.env`, `.env.*` and `*.dec.env`, but not
  every name (`prod.env` is not ignored) — decrypt with `exec-env`/`exec-file` as above and there
  is no copy to commit.
